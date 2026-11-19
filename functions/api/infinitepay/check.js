const HANDLE = "amanda-roberta-wt8";
const json = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
async function db(env,path,options={}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Banco de dados não configurado.");
  const r=await fetch(env.SUPABASE_URL+"/rest/v1/"+path,{...options,headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY,"Content-Type":"application/json",Prefer:"return=representation",...(options.headers||{})}});
  const raw=await r.text(); let data; try{data=raw?JSON.parse(raw):null}catch{data=raw}
  if(!r.ok) throw new Error("Falha ao consultar o pedido.");
  return data;
}
export async function onRequest({request,env}) {
  if(request.method!=="POST") return json({error:"Método não permitido."},405);
  try {
    const body=await request.json();
    const order=String(body.order_nsu||body.pedido_id||"");
    let transaction=String(body.transaction_nsu||"");
    let slug=String(body.slug||"");
    console.log("InfinitePay check request received",{has_order:!!order,has_transaction:!!transaction,has_slug:!!slug});
    if(!/^AFR-[0-9a-f-]{36}$/i.test(order)) { console.error("InfinitePay check missing or invalid order_nsu"); return json({error:"Não recebemos o identificador do pedido no retorno da InfinitePay."},400); }
    const rows=await db(env,"pagamentos_infinitepay?select=order_nsu,total_centavos,status,itens,transaction_nsu,invoice_slug&order_nsu=eq."+encodeURIComponent(order));
    if(!rows?.length) return json({error:"Pedido não encontrado."},404);
    if(rows[0].status==="pago") { console.log("InfinitePay check: order already confirmed by webhook"); return json({paid:true,server:rows[0].itens?.server,items:rows[0].itens?.items||[],capture_method:rows[0].itens?.capture_method||null,installments:rows[0].itens?.installments||null,amount:rows[0].total_centavos,paid_amount:rows[0].itens?.paid_amount||rows[0].total_centavos}); }
    transaction=transaction||String(rows[0].transaction_nsu||"");
    slug=slug||String(rows[0].invoice_slug||"");
    if(!transaction || !slug) { console.error("InfinitePay check missing return identifiers",{has_transaction:!!transaction,has_slug:!!slug,db_has_transaction:!!rows[0].transaction_nsu,db_has_slug:!!rows[0].invoice_slug}); return json({paid:false,pending:true,error:"O retorno da InfinitePay chegou sem o identificador da transação ou da cobrança. A notificação automática ainda não confirmou este pedido."},409); }
    const response=await fetch("https://api.checkout.infinitepay.io/payment_check",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({handle:HANDLE,order_nsu:order,transaction_nsu:transaction,slug})
    });
    const result=await response.json().catch(()=>null);
    if(!response.ok) {
      console.error("InfinitePay payment_check HTTP error",{http_status:response.status,response_fields:result&&typeof result==="object"?Object.keys(result):[]});
      return json({paid:false,pending:true,error:"A InfinitePay respondeu com erro HTTP "+response.status+" ao consultar o pagamento. Tente consultar novamente."},502);
    }
    if(result?.success!==true) {
      console.error("InfinitePay payment_check unsuccessful",{success:result?.success??null,paid:result?.paid??null,response_fields:result&&typeof result==="object"?Object.keys(result):[]});
      return json({paid:false,pending:true,error:"A InfinitePay não validou a consulta (success diferente de true). Confira os dados de retorno e tente novamente."},502);
    }
    if(result?.paid!==true) {
      console.log("InfinitePay payment_check pending",{success:result.success,paid:result.paid});
      return json({paid:false,pending:true,error:"A InfinitePay respondeu que este pedido ainda não consta como pago (paid diferente de true)."},409);
    }
    const method=result.capture_method;
    const installments=method==="credit_card"?Number(result.installments):null;
    const receivedAmount=Number(result.amount);
    const expectedAmount=Number(rows[0].total_centavos);
    if(receivedAmount!==expectedAmount || !["credit_card","pix"].includes(method) || (method==="credit_card" && (!Number.isInteger(installments) || installments<1 || installments>12))) {
      console.error("InfinitePay payment_check validation mismatch",{expected_amount:expectedAmount,received_amount:Number.isFinite(receivedAmount)?receivedAmount:null,capture_method:method??null,installments:Number.isFinite(installments)?installments:null});
      return json({paid:false,pending:true,error:"A InfinitePay confirmou a transação, mas os dados não conferem: valor esperado R$ "+(expectedAmount/100).toFixed(2).replace(".",",")+", valor informado "+(Number.isFinite(receivedAmount)?"R$ "+(receivedAmount/100).toFixed(2).replace(".",","):"inválido")+", método "+String(method||"não informado")+". O pedido ficou bloqueado por segurança."},409);
    }
    await db(env,"pagamentos_infinitepay?order_nsu=eq."+encodeURIComponent(order),{
      method:"PATCH",body:JSON.stringify({status:"pago",transaction_nsu:transaction,invoice_slug:slug,confirmado_em:new Date().toISOString(),itens:{...rows[0].itens,capture_method:method,installments,paid_amount:Number(result.paid_amount||result.amount)}})
    });
    if(rows[0].itens?.atendimento_id) await db(env,"atendimentos?id=eq."+encodeURIComponent(rows[0].itens.atendimento_id),{method:"PATCH",body:JSON.stringify({status_pedido:"pago",servidor:rows[0].itens.server,pacote:(rows[0].itens.items||[]).map(x=>x.name+" x "+x.quantity).join(", "),valor_total:Number(result.paid_amount||result.amount)/100,atualizado_em:new Date().toISOString()})});
    return json({paid:true,server:rows[0].itens?.server,items:rows[0].itens?.items||[],capture_method:method,installments,amount:Number(result.amount),paid_amount:Number(result.paid_amount||result.amount)});
  } catch(error) {
    console.error("InfinitePay check internal error",{message:error?.message||"unknown"});
    return json({error:"Não foi possível confirmar o pagamento agora. Atualize a página em instantes."},500);
  }
}