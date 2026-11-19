const DEFAULT_HANDLE="amanda-roberta-wt8";
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
async function db(env,path,options={}){
 if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)throw new Error("Banco de dados não configurado.");
 const response=await fetch(env.SUPABASE_URL+"/rest/v1/"+path,{...options,headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY,"Content-Type":"application/json",Prefer:"return=representation",...(options.headers||{})}});
 const raw=await response.text();let data;try{data=raw?JSON.parse(raw):null}catch{data=raw}
 if(!response.ok)throw new Error("Supabase HTTP "+response.status+": "+String(raw).slice(0,400));
 return data;
}
async function syncAttendance(env,details,status){
 if(!details?.atendimento_id)return;
 const id=String(details.atendimento_id);
 const current=await db(env,"atendimentos?select=id,status_pedido&id=eq."+encodeURIComponent(id));
 if(!current.length)return;
 const fields={servidor:details.server,pacote:(details.items||[]).map(item=>String(item.name)+" x "+Number(item.quantity)).join(", "),valor_total:Number(details.paid_amount||0)/100,atualizado_em:new Date().toISOString()};
 const currentStatus=String(current[0].status_pedido||"");
 if(status==="pago"&&!["pago","em_andamento","entregue"].includes(currentStatus))fields.status_pedido="pago";
 await db(env,"atendimentos?id=eq."+encodeURIComponent(id),{method:"PATCH",body:JSON.stringify(fields)});
}
function paymentResponse(row){
 const details=row.itens||{};
 return {paid:true,order_nsu:row.order_nsu,status_pedido:"pago",amount:Number(row.total_centavos),paid_amount:Number(details.paid_amount||row.total_centavos),capture_method:details.capture_method||null,installments:details.installments||null,server:details.server||null,items:details.items||[]};
}
export async function onRequest({request,env}){
 if(request.method!=="POST")return json({error:"Método não permitido."},405);
 try{
  const body=await request.json();
  const orderNsu=String(body.order_nsu||body.pedido_id||body.pedidoId||body.id||"").trim();
  let transactionNsu=String(body.transaction_nsu||body.transaction_id||body.transactionId||"").trim();
  if(!orderNsu&&!transactionNsu)return json({error:"Informe o identificador do pedido ou da transação para consultar o pagamento."},400);
  let rows=orderNsu
   ? await db(env,"pagamentos_infinitepay?select=order_nsu,total_centavos,status,itens,transaction_nsu,invoice_slug&order_nsu=eq."+encodeURIComponent(orderNsu))
   : await db(env,"pagamentos_infinitepay?select=order_nsu,total_centavos,status,itens,transaction_nsu,invoice_slug&transaction_nsu=eq."+encodeURIComponent(transactionNsu));
  if(!rows?.length&&orderNsu&&transactionNsu){
   rows=await db(env,"pagamentos_infinitepay?select=order_nsu,total_centavos,status,itens,transaction_nsu,invoice_slug&transaction_nsu=eq."+encodeURIComponent(transactionNsu));
  }
  if(!rows?.length)return json({error:"Pedido não encontrado. Confira o identificador retornado pela InfinitePay."},404);
  const row=rows[0];
  const canonicalOrderNsu=String(row.order_nsu||"");
  if(!canonicalOrderNsu)return json({error:"O pedido encontrado não possui identificador de cobrança."},409);
  if(row.status==="pago"){await syncAttendance(env,row.itens,"pago");return json(paymentResponse(row));}
  if(row.status!=="pendente")return json({paid:false,pending:false,error:"Este pedido não está disponível para confirmação."},409);
  transactionNsu=transactionNsu||String(row.transaction_nsu||"").trim();
  const slug=String(body.slug||"").trim();
  const handle=String(body.handle||env.INFINITEPAY_HANDLE||DEFAULT_HANDLE).replace(/^\$/,"").trim();
  const sent={handle,order_nsu:canonicalOrderNsu,transaction_nsu:transactionNsu||undefined,slug:slug||undefined};
  const response=await fetch("https://api.infinitepay.io/invoices/public/checkout/payment_check",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(sent)});
  const raw=await response.text();let result;try{result=raw?JSON.parse(raw):null}catch{result={raw_response:raw};}
  console.log("InfinitePay payment_check",{http_status:response.status,success:result?.success??null,paid:result?.paid??null,has_order:true,has_transaction:!!transactionNsu,has_slug:!!slug});
  if(!response.ok||result?.success===false||result?.paid!==true){
   return json({paid:false,pending:true,error:!response.ok?"A InfinitePay respondeu HTTP "+response.status+".":"A InfinitePay ainda não confirmou o pagamento.",diagnostic:{resposta_http:response.status}},response.ok?409:502);
  }
  const method=result.capture_method,installments=method==="credit_card"?Number(result.installments):null;
  if(Number(result.amount)!==Number(row.total_centavos)||!(method==="pix"||method==="credit_card")||(method==="credit_card"&&(!Number.isInteger(installments)||installments<1||installments>12))){
   console.error("InfinitePay payment mismatch",{order_nsu:canonicalOrderNsu,expected_amount:row.total_centavos,received_amount:result.amount,capture_method:method});
   return json({paid:false,pending:false,error:"O pagamento retornado não corresponde ao valor ou às condições deste pedido. Fale com o atendimento."},409);
  }
  const paidAmount=Number(result.paid_amount||result.amount);
  if(!Number.isFinite(paidAmount)||paidAmount<=0)return json({paid:false,pending:false,error:"A InfinitePay retornou um valor pago inválido."},409);
  const details={...(row.itens||{}),capture_method:method,installments,paid_amount:paidAmount};
  const patch={status:"pago",transaction_nsu:transactionNsu||row.transaction_nsu||null,invoice_slug:slug||row.invoice_slug||null,confirmado_em:new Date().toISOString(),itens:details};
  await db(env,"pagamentos_infinitepay?order_nsu=eq."+encodeURIComponent(canonicalOrderNsu),{method:"PATCH",body:JSON.stringify(patch)});
  await syncAttendance(env,details,"pago");
  return json(paymentResponse({...row,status:"pago",itens:details}));
 }catch(error){
  console.error("InfinitePay check error",{message:error?.message||"unknown"});
  return json({error:"Não foi possível consultar a InfinitePay agora."},500);
 }
}
