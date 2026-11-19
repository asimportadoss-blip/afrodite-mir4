const DEFAULT_HANDLE="amanda-roberta-wt8";
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
async function upsertAttendance(env,record){
  if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Credenciais do Supabase ausentes.");
  const response=await fetch(env.SUPABASE_URL+"/rest/v1/atendimentos?on_conflict=id",{
    method:"POST",
    headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY,"Content-Type":"application/json",Prefer:"resolution=merge-duplicates,return=minimal"},
    body:JSON.stringify(record)
  });
  if(!response.ok) throw new Error("Supabase atendimentos HTTP "+response.status+": "+(await response.text()).slice(0,400));
}
export async function onRequest({request,env}){
  if(request.method!=="POST")return json({error:"Método não permitido."},405);
  try{
    const body=await request.json();
    const orderNsu=String(body.order_nsu||body.pedido_id||body.pedidoId||body.id||"").trim();
    const transactionNsu=String(body.transaction_nsu||body.transaction_id||body.transactionId||"").trim();
    const slug=String(body.slug||"").trim();
    const handle=String(body.handle||env.INFINITEPAY_HANDLE||DEFAULT_HANDLE).replace(/^\$/,"").trim();
    if(!orderNsu&&!transactionNsu)return json({error:"Informe order_nsu ou transaction_nsu."},400);
    const sent={handle,order_nsu:orderNsu||undefined,transaction_nsu:transactionNsu||undefined,slug:slug||undefined};
    const response=await fetch("https://api.infinitepay.io/invoices/public/checkout/payment_check",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(sent)});
    const raw=await response.text();let result;try{result=raw?JSON.parse(raw):null}catch{result={raw_response:raw};}
    console.log("InfinitePay payment_check",{http_status:response.status,paid:result?.paid??null,success:result?.success??null,has_order:!!orderNsu,has_transaction:!!transactionNsu,has_slug:!!slug});
    if(!response.ok||result?.paid!==true)return json({paid:false,pending:true,error:!response.ok?"A InfinitePay respondeu HTTP "+response.status+".":"A InfinitePay ainda não confirmou o pagamento.",infinitepay_raw:result,diagnostic:{enviado:sent,resposta_http:response.status,resposta:result}},response.ok?409:502);

    // A aprovação da InfinitePay é definitiva para liberar a etapa; o Supabase é atualizado em seguida, sem bloquear o cliente.
    const record={id:orderNsu,status_pedido:"pago",atualizado_em:new Date().toISOString()};
    for(const key of ["cliente_nome","servidor","pacote","valor_total"])if(body[key]!==undefined&&body[key]!==null)record[key]=body[key];
    try{await upsertAttendance(env,record);}
    catch(error){console.error("Pagamento aprovado; falha ao atualizar atendimentos (não bloqueia o cliente)",{message:error?.message||"unknown",order_nsu:orderNsu});}
    return json({paid:true,order_nsu:orderNsu,status_pedido:"pago"});
  }catch(error){
    console.error("InfinitePay check error",{message:error?.message||"unknown"});
    return json({error:"Não foi possível consultar a InfinitePay agora."},500);
  }
}
