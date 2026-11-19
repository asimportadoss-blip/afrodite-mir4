const DEFAULT_HANDLE="amanda-roberta-wt8";
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
async function upsertAttendance(env,orderNsu){
 if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)throw new Error("Supabase não configurado.");
 const response=await fetch(env.SUPABASE_URL+"/rest/v1/atendimentos?on_conflict=id",{
  method:"POST",
  headers:{
   apikey:env.SUPABASE_SERVICE_ROLE_KEY,
   Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY,
   "Content-Type":"application/json",
   Prefer:"resolution=merge-duplicates,return=minimal"
  },
  body:JSON.stringify({id:orderNsu,status_pedido:"pago",atualizado_em:new Date().toISOString()})
 });
 const raw=await response.text();
 if(!response.ok)throw new Error("Supabase HTTP "+response.status+": "+raw.slice(0,300));
}
export async function onRequest({request,env}){
 if(request.method!=="POST")return json({error:"Método não permitido."},405);
 let body;
 try{body=await request.json()}catch{return json({error:"Corpo JSON inválido."},400)}
 const orderNsu=String(body.order_nsu||body.pedido_id||body.pedidoId||body.id||"").trim();
 const transactionNsu=String(body.transaction_nsu||body.transaction_id||body.transactionId||"").trim();
 const slug=String(body.slug||"").trim();
 if(!orderNsu&&!transactionNsu)return json({error:"Informe order_nsu ou transaction_nsu para consultar o pagamento."},400);
 const handle=String(body.handle||env.INFINITEPAY_HANDLE||DEFAULT_HANDLE).replace(/^\$/,"").trim();
 const sent={handle,order_nsu:orderNsu,transaction_nsu:transactionNsu,slug};
 try{
  // A InfinitePay é a fonte primária. A ausência de registro no Supabase nunca bloqueia a consulta.
  const response=await fetch("https://api.infinitepay.io/invoices/public/checkout/payment_check",{
   method:"POST",
   headers:{"Content-Type":"application/json"},
   body:JSON.stringify(sent)
  });
  const raw=await response.text();
  let result;
  try{result=raw?JSON.parse(raw):null}catch{result={raw_response:raw}}
  const paid=result?.paid===true||Number(result?.paid_amount)>0;
  if(!response.ok||!paid){
   return json({paid:false,status:"pendente",infinitepay_raw:result,enviado:sent},200);
  }
  // O pagamento foi confirmado pela InfinitePay. Tentamos sincronizar o atendimento,
  // mas uma falha de gravação não transforma um pagamento confirmado em pendente.
  try{
   if(orderNsu)await upsertAttendance(env,orderNsu);
  }catch(dbError){
   console.error("InfinitePay confirmed; attendance upsert failed",{order_nsu:orderNsu,message:dbError?.message||"unknown"});
  }
  return json({paid:true,status:"pago",order_nsu:orderNsu},200);
 }catch(error){
  console.error("InfinitePay payment_check error",{message:error?.message||"unknown"});
  return json({paid:false,status:"pendente",error:"Não foi possível consultar a InfinitePay agora."},502);
 }
}
