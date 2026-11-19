const HANDLE = "amanda-roberta-wt8";
const json = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
async function db(env,path,options={}) {
  if(!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Banco de dados não configurado.");
  const r=await fetch(env.SUPABASE_URL+"/rest/v1/"+path,{...options,headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY,"Content-Type":"application/json",Prefer:"return=representation",...(options.headers||{})}});
  const raw=await r.text();let data;try{data=raw?JSON.parse(raw):null}catch{data=raw}
  if(!r.ok) throw new Error("Falha ao atualizar o pedido.");
  return data;
}
export async function onRequest({request,env}) {
  if(request.method!=="POST") return json({error:"Método não permitido."},405);
  try {
    const event=await request.json();
    const order=String(event.order_nsu||"");
    const transaction=String(event.transaction_nsu||"");
    const slug=String(event.invoice_slug||event.slug||"");
    if(!/^AFR-[0-9a-f-]{36}$/i.test(order) || !transaction || !slug) return json({received:true,ignored:true});
    const rows=await db(env,"pagamentos_infinitepay?select=order_nsu,total_centavos,status,itens&order_nsu=eq."+encodeURIComponent(order));
    if(!rows?.length) return json({received:true,ignored:true});
    if(rows[0].status==="pago") return json({received:true,already_paid:true});
    const response=await fetch("https://api.checkout.infinitepay.io/payment_check",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({handle:HANDLE,order_nsu:order,transaction_nsu:transaction,slug})
    });
    const result=await response.json().catch(()=>null);
    if(!response.ok || result?.success!==true || result?.paid!==true) return json({received:true,confirmed:false});
    const method=result.capture_method;
    const installments=method==="credit_card"?Number(result.installments):null;
    if(Number(result.amount)!==Number(rows[0].total_centavos) || !["credit_card","pix"].includes(method) || (method==="credit_card" && (!Number.isInteger(installments)||installments<1||installments>12))) return json({received:true,confirmed:false});
    await db(env,"pagamentos_infinitepay?order_nsu=eq."+encodeURIComponent(order),{
      method:"PATCH",
      body:JSON.stringify({status:"pago",transaction_nsu:transaction,invoice_slug:slug,confirmado_em:new Date().toISOString(),itens:{...rows[0].itens,capture_method:method,installments,paid_amount:Number(result.paid_amount||result.amount)}})
    });
    return json({received:true,confirmed:true});
  } catch(error) {
    return json({error:"Não foi possível processar a notificação."},500);
  }
}
