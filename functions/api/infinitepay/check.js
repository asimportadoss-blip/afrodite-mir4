const DEFAULT_HANDLE = "amanda-roberta-wt8";
const json = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
async function db(env,path,options={}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Banco de dados não configurado.");
  const response=await fetch(env.SUPABASE_URL+"/rest/v1/"+path,{...options,headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY,"Content-Type":"application/json",Prefer:"return=representation",...(options.headers||{})}});
  const raw=await response.text();let data;try{data=raw?JSON.parse(raw):null}catch{data=raw}
  if(!response.ok) throw new Error("Supabase HTTP "+response.status+": "+String(raw).slice(0,400));
  return data;
}
export async function onRequest({request,env}) {
  if(request.method!=="POST") return json({error:"Método não permitido."},405);
  try {
    const body=await request.json();
    const orderNsu=String(body.order_nsu||body.pedido_id||body.pedidoId||body.id||"").trim();
    const transactionNsu=String(body.transaction_nsu||body.transaction_id||body.transactionId||"").trim();
    const slug=String(body.slug||"").trim();
    const handle=String(body.handle||env.INFINITEPAY_HANDLE||DEFAULT_HANDLE).replace(/^\$/,"").trim();
    if(!orderNsu&&!transactionNsu) {
      return json({error:"Informe order_nsu ou transaction_nsu.",received_fields:Object.keys(body||{})},400);
    }
    const sent={handle,order_nsu:orderNsu||undefined,transaction_nsu:transactionNsu||undefined,slug:slug||undefined};
    console.log("InfinitePay check received",{has_order:!!orderNsu,has_transaction:!!transactionNsu,has_slug:!!slug,handle});
    let rows=[];
    if(orderNsu) rows=await db(env,"pagamentos_infinitepay?select=order_nsu,total_centavos,status,itens,transaction_nsu,invoice_slug&order_nsu=eq."+encodeURIComponent(orderNsu));
    // O frontend também pode receber o UUID do atendimento; nesse caso, localize o pagamento pelo vínculo salvo no JSON itens.
    if(!rows.length&&orderNsu) rows=await db(env,"pagamentos_infinitepay?select=order_nsu,total_centavos,status,itens,transaction_nsu,invoice_slug&itens->>atendimento_id=eq."+encodeURIComponent(orderNsu));
    if(!rows.length&&transactionNsu) rows=await db(env,"pagamentos_infinitepay?select=order_nsu,total_centavos,status,itens,transaction_nsu,invoice_slug&transaction_nsu=eq."+encodeURIComponent(transactionNsu));
    if(!rows.length) {
      const atendimento=orderNsu?await db(env,"atendimentos?select=id,status_pedido&id=eq."+encodeURIComponent(orderNsu)).catch(()=>[]):[];
      if(atendimento[0]?.status_pedido==="pago") return json({paid:true,order_nsu:orderNsu});
      return json({error:"Pedido não encontrado no registro de pagamentos.",diagnostic:{enviado:sent,order_nsu_recebido:orderNsu,transaction_nsu_recebido:transactionNsu}},404);
    }
    const payment=rows[0];
    const canonicalOrder=String(payment.order_nsu||orderNsu||"");
    const finalTransaction=transactionNsu||String(payment.transaction_nsu||"");
    const finalSlug=slug||String(payment.invoice_slug||"");
    const atendimentoId=payment.itens?.atendimento_id||null;
    const atendimentoRows=atendimentoId?await db(env,"atendimentos?select=id,servidor,pacote,valor_total,status_pedido&id=eq."+encodeURIComponent(atendimentoId)).catch(()=>[]):[];
    if(payment.status==="pago"||atendimentoRows[0]?.status_pedido==="pago") {
      if(payment.status!=="pago") await db(env,"pagamentos_infinitepay?order_nsu=eq."+encodeURIComponent(canonicalOrder),{method:"PATCH",body:JSON.stringify({status:"pago",confirmado_em:new Date().toISOString()})});
      return json({paid:true,order_nsu:canonicalOrder,server:payment.itens?.server||atendimentoRows[0]?.servidor,items:payment.itens?.items||[],amount:payment.total_centavos,atendimento:atendimentoRows[0]||null});
    }
    const requestBody={handle,order_nsu:canonicalOrder||orderNsu,transaction_nsu:finalTransaction||transactionNsu,slug:finalSlug||slug};
    await db(env,"pagamentos_infinitepay?order_nsu=eq."+encodeURIComponent(canonicalOrder),{method:"PATCH",body:JSON.stringify({transaction_nsu:finalTransaction||null,invoice_slug:finalSlug||null})}).catch(error=>console.error("Não foi possível persistir os identificadores do retorno",{message:error?.message}));
    const response=await fetch("https://api.infinitepay.io/invoices/public/checkout/payment_check",{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(requestBody)
    });
    const raw=await response.text();let result;try{result=raw?JSON.parse(raw):null}catch{result={raw_response:raw};}
    const diagnostic={enviado:requestBody,resposta_http:response.status,resposta:result};
    console.log("InfinitePay payment_check result",{http_status:response.status,success:result?.success??null,paid:result?.paid??null,has_order:!!canonicalOrder,has_transaction:!!finalTransaction,has_slug:!!finalSlug});
    if(!response.ok) return json({paid:false,pending:true,error:"A InfinitePay respondeu HTTP "+response.status+".",diagnostic},502);
    // success=true confirma que a consulta foi processada; somente paid=true comprova pagamento.
    if(result?.paid!==true) return json({paid:false,pending:true,error:"A InfinitePay ainda não confirmou o pagamento (paid diferente de true).",diagnostic},409);
    const method=result.capture_method;
    const installments=method==="credit_card"?Number(result.installments):null;
    const receivedAmount=Number(result.amount);
    const expectedAmount=Number(payment.total_centavos);
    if(receivedAmount!==expectedAmount||!["credit_card","pix"].includes(method)||(method==="credit_card"&&(!Number.isInteger(installments)||installments<1||installments>12))) {
      return json({paid:false,pending:true,error:"A InfinitePay confirmou uma transação, mas valor ou método não conferem. O pedido permanece bloqueado.",diagnostic:{...diagnostic,valor_esperado_centavos:expectedAmount,valor_recebido_centavos:Number.isFinite(receivedAmount)?receivedAmount:null}},409);
    }
    const now=new Date().toISOString();
    await db(env,"pagamentos_infinitepay?order_nsu=eq."+encodeURIComponent(canonicalOrder),{method:"PATCH",body:JSON.stringify({status:"pago",transaction_nsu:finalTransaction,invoice_slug:finalSlug,confirmado_em:now,itens:{...payment.itens,capture_method:method,installments,paid_amount:Number(result.paid_amount||result.amount)}})});
    if(atendimentoId) await db(env,"atendimentos?id=eq."+encodeURIComponent(atendimentoId),{method:"PATCH",body:JSON.stringify({status_pedido:"pago",servidor:payment.itens?.server,pacote:(payment.itens?.items||[]).map(x=>x.name+" x "+x.quantity).join(", "),valor_total:Number(result.paid_amount||result.amount)/100,atualizado_em:now})});
    return json({paid:true,order_nsu:canonicalOrder,server:payment.itens?.server,items:payment.itens?.items||[],capture_method:method,installments,amount:receivedAmount,paid_amount:Number(result.paid_amount||result.amount)});
  } catch(error) {
    console.error("InfinitePay check internal error",{message:error?.message||"unknown"});
    return json({error:"Não foi possível confirmar o pagamento agora."},500);
  }
}
