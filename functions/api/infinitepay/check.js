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
    const order=String(body.order_nsu||"");
    const transaction=String(body.transaction_nsu||"");
    const slug=String(body.slug||"");
    if(!/^AFR-[0-9a-f-]{36}$/i.test(order) || !transaction || !slug) return json({paid:false,pending:true});
    const rows=await db(env,"pagamentos_infinitepay?select=order_nsu,total_centavos,status,itens&order_nsu=eq."+encodeURIComponent(order));
    if(!rows?.length) return json({error:"Pedido não encontrado."},404);
    if(rows[0].status==="pago") return json({paid:true,server:rows[0].itens?.server,items:rows[0].itens?.items||[]});
    const response=await fetch("https://api.checkout.infinitepay.io/payment_check",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({handle:HANDLE,order_nsu:order,transaction_nsu:transaction,slug})
    });
    const result=await response.json().catch(()=>null);
    if(!response.ok || result?.success!==true || result?.paid!==true) return json({paid:false,pending:true});
    if(Number(result.amount)!==Number(rows[0].total_centavos) || result.capture_method!=="credit_card") return json({paid:false,pending:true,error:"O pagamento ainda não pôde ser validado."},409);
    await db(env,"pagamentos_infinitepay?order_nsu=eq."+encodeURIComponent(order),{
      method:"PATCH",body:JSON.stringify({status:"pago",transaction_nsu:transaction,invoice_slug:slug,confirmado_em:new Date().toISOString()})
    });
    return json({paid:true,server:rows[0].itens?.server,items:rows[0].itens?.items||[]});
  } catch(error) {
    return json({error:"Não foi possível confirmar o pagamento agora. Atualize a página em instantes."},500);
  }
}