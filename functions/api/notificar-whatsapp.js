const ALERT_TEXT="🔔 Novo atendimento/mensagem no site Afrodite MIR4! Acesse o Painel Admin para responder e entregar.";
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
export async function onRequest({request,env}){
 if(request.method!=="POST")return json({error:"Método não permitido."},405);
 if(!env.WHATSAPP_ALERT_URL||!env.WHATSAPP_PHONE)return json({error:"Configure WHATSAPP_ALERT_URL e WHATSAPP_PHONE nas variáveis do Cloudflare."},503);
 const token=String(env.WHATSAPP_ALERT_TOKEN||"");
 if(!token||request.headers.get("Authorization")!=="Bearer "+token)return json({error:"Não autorizado."},401);
 try{
  const response=await fetch(env.WHATSAPP_ALERT_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone:env.WHATSAPP_PHONE,message:ALERT_TEXT})});
  const raw=await response.text();
  if(!response.ok){console.error("WhatsApp alert provider error",{status:response.status,response:raw.slice(0,300)});return json({success:false,error:"O provedor de WhatsApp recusou a notificação.",provider_status:response.status},502)}
  return json({success:true});
 }catch(error){console.error("WhatsApp alert request failed",{message:error?.message||"unknown"});return json({success:false,error:"Não foi possível conectar ao provedor de WhatsApp."},502)}
}
