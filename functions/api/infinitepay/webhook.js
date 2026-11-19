const HANDLE = "amanda-roberta-wt8";
const json = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
async function db(env,path,options={}) {
  if(!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Banco de dados não configurado.");
  const r=await fetch(env.SUPABASE_URL+"/rest/v1/"+path,{...options,headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY,"Content-Type":"application/json",Prefer:"return=representation",...(options.headers||{})}});
  const raw=await r.text();let data;try{data=raw?JSON.parse(raw):null}catch{data=raw}
  if(!r.ok) throw new Error("Supabase HTTP "+r.status+": "+String(raw).slice(0,500));
  return data;
}
export async function onRequest({request,env}) {
  if(request.method!=="POST") return json({error:"Método não permitido."},405);
  try {
    const event=await request.json();
    const order=String(event.order_nsu||event.pedido_id||"");
    const transaction=String(event.transaction_nsu||"");
    const slug=String(event.invoice_slug||event.slug||"");
    const eventAmount=Number(event.paid_amount??event.amount??0);
    console.log("InfinitePay webhook recebido",{fields:Object.keys(event||{}),has_order:!!order,has_transaction:!!transaction,has_slug:!!slug,paid:event.paid===true,has_positive_amount:Number.isFinite(eventAmount)&&eventAmount>0});
    if(!/^AFR-[0-9a-f-]{36}$/i.test(order)) {
      console.error("Webhook sem order_nsu válido",{has_order:!!order});
      return json({success:true,ignored:true,reason:"invalid_order_nsu"});
    }
    const rows=await db(env,"pagamentos_infinitepay?select=order_nsu,total_centavos,status,itens,transaction_nsu,invoice_slug&order_nsu=eq."+encodeURIComponent(order));
    if(!rows?.length) return json({success:true,ignored:true,reason:"order_not_found"});
    const saved={};
    if(transaction) saved.transaction_nsu=transaction;
    if(slug) saved.invoice_slug=slug;
    if(Object.keys(saved).length) {
      await db(env,"pagamentos_infinitepay?order_nsu=eq."+encodeURIComponent(order),{method:"PATCH",body:JSON.stringify(saved)});
    }
    if(rows[0].status==="pago") {
      const details=rows[0].itens||{};
      if(details.atendimento_id){
        const current=await db(env,"atendimentos?select=id,status_pedido&id=eq."+encodeURIComponent(details.atendimento_id));
        if(current.length){
          const fields={servidor:details.server,pacote:(details.items||[]).map(x=>String(x.name)+" x "+Number(x.quantity)).join(", "),valor_total:Number(details.paid_amount||rows[0].total_centavos)/100,atualizado_em:new Date().toISOString()};
          if(!["pago","em_andamento","entregue"].includes(String(current[0].status_pedido||"")))fields.status_pedido="pago";
          await db(env,"atendimentos?id=eq."+encodeURIComponent(details.atendimento_id),{method:"PATCH",body:JSON.stringify(fields)});
        }
      }
      return json({success:true,already_paid:true});
    }
    const finalTransaction=transaction||rows[0].transaction_nsu||"";
    const finalSlug=slug||rows[0].invoice_slug||"";
    if(!finalTransaction||!finalSlug) {
      console.log("Webhook recebido, aguardando identificadores completos",{has_transaction:!!finalTransaction,has_slug:!!finalSlug});
      return json({success:true,received:true,awaiting_identifiers:true});
    }
    const sent={handle:HANDLE,order_nsu:order,transaction_nsu:finalTransaction,slug:finalSlug};
    const response=await fetch("https://api.infinitepay.io/invoices/public/checkout/payment_check",{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(sent)
    });
    const raw=await response.text();
    let result=null;try{result=raw?JSON.parse(raw):null}catch{result={raw_response:raw};}
    console.log("InfinitePay webhook payment_check diagnóstico",{http_status:response.status,sent,response:result});
    if(!response.ok||result?.success!==true||result?.paid!==true) {
      return json({success:true,received:true,confirmed:false,awaiting_validation:true,diagnostic:{enviado:sent,resposta_http:response.status,resposta:result}});
    }
    const method=result.capture_method;
    const installments=method==="credit_card"?Number(result.installments):null;
    if(Number(result.amount)!==Number(rows[0].total_centavos)||!["credit_card","pix"].includes(method)||(method==="credit_card"&&(!Number.isInteger(installments)||installments<1||installments>12))) {
      console.error("Webhook: pagamento confirmado mas divergente",{expected_amount:rows[0].total_centavos,result});
      return json({success:true,received:true,confirmed:false,reason:"payment_mismatch"});
    }
    await db(env,"pagamentos_infinitepay?order_nsu=eq."+encodeURIComponent(order),{
      method:"PATCH",body:JSON.stringify({status:"pago",transaction_nsu:finalTransaction,invoice_slug:finalSlug,confirmado_em:new Date().toISOString(),itens:{...rows[0].itens,capture_method:method,installments,paid_amount:Number(result.paid_amount||result.amount)}})
    });
    if(rows[0].itens?.atendimento_id) await db(env,"atendimentos?id=eq."+encodeURIComponent(rows[0].itens.atendimento_id),{method:"PATCH",body:JSON.stringify({status_pedido:"pago",servidor:rows[0].itens.server,pacote:(rows[0].itens.items||[]).map(x=>x.name+" x "+x.quantity).join(", "),valor_total:Number(result.paid_amount||result.amount)/100,atualizado_em:new Date().toISOString()})});
    return json({success:true,received:true,confirmed:true});
  } catch(error) {
    console.error("InfinitePay webhook internal error",{message:error?.message||"unknown"});
    return json({success:false,error:"Falha ao processar a notificação."},500);
  }
}
