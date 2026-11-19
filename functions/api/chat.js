const COOKIE = "afrodite_chat_session";
const enc = new TextEncoder();
function json(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store, private",...headers}})}
function b64(bytes){let s="";for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/=/g,"").replaceAll("+","-").replaceAll("/","_")}
async function digest(value){return b64(new Uint8Array(await crypto.subtle.digest("SHA-256",enc.encode(value))))}
function cookieValue(request,name){const row=(request.headers.get("Cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="));return row?decodeURIComponent(row.slice(name.length+1)):""}
function b64url(bytes){return b64(bytes)}
async function adminValid(request,env){
 const raw=cookieValue(request,"afrodite_admin_session");if(!raw||!env.ADMIN_PASSWORD||!env.ADMIN_USER)return false;
 try{const [payload,sig,...rest]=raw.split(".");if(!payload||!sig||rest.length)return false;
 const key=await crypto.subtle.importKey("raw",enc.encode(env.ADMIN_PASSWORD),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const expected=b64url(new Uint8Array(await crypto.subtle.sign("HMAC",key,enc.encode(payload))));
 if(sig!==expected)return false;
 const data=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-payload.length%4)%4)),c=>c.charCodeAt(0))));
 return data.user===env.ADMIN_USER&&Number(data.exp)>Math.floor(Date.now()/1000);
 }catch{return false}
}
function headers(env){return {apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY,"Content-Type":"application/json",Prefer:"return=representation"}}
async function db(env,path,options={}){if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)throw new Error("Supabase não configurado no servidor.");const r=await fetch(env.SUPABASE_URL+"/rest/v1/"+path,{...options,headers:{...headers(env),...(options.headers||{})}});const t=await r.text();let data;try{data=t?JSON.parse(t):null}catch{data=t}if(!r.ok)throw new Error(typeof data==="object"?(data.message||data.details||"Falha no Supabase."):String(data));return data}
function sessionCookie(token){return COOKIE+"="+encodeURIComponent(token)+"; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000"}
async function sendWhatsappAlert(env,message){
 const target=String(env.WHATSAPP_ALERT_URL||"").trim(),phone=String(env.WHATSAPP_PHONE||"").trim();
 if(!target||!phone){console.log("WhatsApp alert not configured");return false}
 try{
  const response=await fetch(target,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone,message})});
  if(!response.ok){console.error("WhatsApp alert HTTP error",{status:response.status});return false}
  return true;
 }catch(error){console.error("WhatsApp alert failed",{message:error?.message||"unknown"});return false}
}
function fail(e){return json({error:e.message||"Erro interno."},500)}
export async function onRequest(context){
 const {request,env}=context;
 try{
  const url=new URL(request.url),admin=url.searchParams.get("admin")==="1";
  if(request.method==="GET"&&admin){
   if(!await adminValid(request,env))return json({error:"Acesso administrativo não autorizado."},401);
   const rows=await db(env,"atendimentos?select=id,cliente_nome,servidor,pacote,valor_total,status_item_mercado,print_url,status_pedido,ultima_mensagem,nao_lidas,atualizado_em&order=atualizado_em.desc");
   const atendimentos=rows.map(({cliente_nome,ultima_mensagem,...row})=>({...row,nome_do_cliente:cliente_nome,"última_mensagem":ultima_mensagem}));
   const selected=url.searchParams.get("atendimento_id");
   if(selected){const rawMsgs=await db(env,"mensagens?select=id,atendimento_id,remetente,texto,criado_em&atendimento_id=eq."+encodeURIComponent(selected)+"&order=criado_em.asc");const msgs=rawMsgs.map(({remetente,...m})=>({...m,referente:remetente}));return json({atendimento:atendimentos.find(x=>x.id===selected)||null,mensagens:msgs})}
   return json({atendimentos});
  }
  if(request.method==="GET"){
   let token=cookieValue(request,COOKIE),setCookie="";
   if(!token){token=b64(crypto.getRandomValues(new Uint8Array(32)));const hash=await digest(token);const id="AFR-"+crypto.randomUUID();await db(env,"atendimentos",{method:"POST",body:JSON.stringify({id,cliente_nome:"Visitante MIR4",status_pedido:"chat_ativo",nao_lidas:0,token_hash:hash})});setCookie=sessionCookie(token)}
   const hash=await digest(token),found=await db(env,"atendimentos?select=id,cliente_nome,servidor,pacote,valor_total,status_pedido&id=not.is.null&token_hash=eq."+encodeURIComponent(hash));
   if(!found.length)return json({error:"Sessão de atendimento inválida."},401);
   const rawMsgs=await db(env,"mensagens?select=id,remetente,texto,criado_em&atendimento_id=eq."+encodeURIComponent(found[0].id)+"&order=criado_em.asc");const msgs=rawMsgs.map(({remetente,...m})=>({...m,referente:remetente}));
   return json({atendimento:found[0],mensagens:msgs},200,setCookie?{"Set-Cookie":setCookie}:{});
  }
  if(request.method==="POST"){
   const body=await request.json().catch(()=>null);if(!body||typeof body.text!=="string"||!body.text.trim()||body.text.length>2000)return json({error:"Mensagem inválida."},400);
   const text=body.text.trim();let atendimentoId,referente;
   if(body.admin===true){
    if(!await adminValid(request,env))return json({error:"Acesso administrativo não autorizado."},401);
    atendimentoId=String(body.atendimento_id||"");if(!atendimentoId)return json({error:"Atendimento não informado."},400);referente="atendente";
    const check=await db(env,"atendimentos?select=id&id=eq."+encodeURIComponent(atendimentoId));if(!check.length)return json({error:"Atendimento não encontrado."},404);
   }else{
    const token=cookieValue(request,COOKIE);if(!token)return json({error:"Abra novamente o atendimento."},401);
    const hash=await digest(token),found=await db(env,"atendimentos?select=id&id=eq."+encodeURIComponent(body.atendimento_id||"")+"&token_hash=eq."+encodeURIComponent(hash));
    if(!found.length)return json({error:"Sessão de atendimento inválida."},403);
    atendimentoId=found[0].id;referente="cliente";
   }
   const now=new Date().toISOString();
   const patch={ultima_mensagem:text,atualizado_em:now};
   if(referente==="cliente")patch.nao_lidas=1;
   if(referente==="cliente"&&body.order_complete===true){
    const printUrl=String(body.print_url||"");
    if(!printUrl.startsWith("data:image/")||printUrl.length>3000000)return json({error:"O print enviado é inválido ou excede o limite permitido."},400);
    patch.servidor=String(body.servidor||"").slice(0,80);
    patch.pacote=String(body.pacote||"").slice(0,300);
    patch.valor_total=Number(body.valor_total);
    patch.status_item_mercado=String(body.status_item_mercado||"").slice(0,100);
    patch.print_url=printUrl;
    patch.status_pedido="pago";
   }
   await db(env,"atendimentos?id=eq."+encodeURIComponent(atendimentoId),{method:"PATCH",body:JSON.stringify(patch)});
   const inserted=await db(env,"mensagens",{method:"POST",body:JSON.stringify({atendimento_id:atendimentoId,remetente:referente,texto:text})});
   const mensagem=inserted?.[0]?(({remetente,...m})=>({...m,referente:remetente}))(inserted[0]):null;
   if(referente==="cliente"){
    const alertText="🔔 Novo atendimento/mensagem no site Afrodite MIR4! Acesse o Painel Admin para responder e entregar.";
    if(typeof context.waitUntil==="function")context.waitUntil(sendWhatsappAlert(env,alertText));
    else await sendWhatsappAlert(env,alertText);
   }
   return json({ok:true,mensagem,order_saved:referente==="cliente"&&body.order_complete===true});
  }
  return json({error:"Método não permitido."},405);
 }catch(e){return fail(e)}
}