const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
export async function onRequest({request,env}){
 if(request.method!=="POST")return json({success:true,error:"Método não permitido."},200);
 try{
  const body=await request.json().catch(()=>({}));
  const token=String(env.TELEGRAM_BOT_TOKEN||"").trim(),chatId=String(env.TELEGRAM_CHAT_ID||"").trim();
  if(!token||!chatId){console.error("Telegram credentials are not configured");return json({success:true,warning:"Telegram não configurado."},200)}
  const tipo=body.tipo==="novo_pedido"?"novo_pedido":"mensagem";
  const texto=tipo==="novo_pedido"
   ? "🔔 NOVO PEDIDO PAGO - AFRODITE MIR4\nPedido: "+(body.pedido_id||"—")+"\nPacote: "+(body.pacote||"—")+"\nValor: "+(body.valor_total||"—")+"\nServidor: "+(body.servidor||"—")+"\nAcesse o Painel Admin para entregar!"
   : "💬 NOVA MENSAGEM NO CHAT - AFRODITE MIR4\nCliente: "+(body.cliente_nome||"Cliente")+"\nMensagem: \""+String(body.mensagem||"").slice(0,1000)+"\"\nAcesse o Painel Admin para responder!";
  const response=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text:texto})});
  if(!response.ok)console.error("Telegram API returned an error",{status:response.status,body:(await response.text()).slice(0,300)});
  return json({success:true});
 }catch(error){console.error("Telegram notification failed",{message:error?.message||"unknown"});return json({success:true})}
}
