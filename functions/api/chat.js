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
async function sendTelegramAlert(env,payload,context){
 const token=String(env.TELEGRAM_BOT_TOKEN||"").trim(),chatId=String(env.TELEGRAM_CHAT_ID||"").trim();
 if(!token||!chatId)return;
 const text=payload.tipo==="novo_pedido"
  ? ["🔔 NOVO PEDIDO PAGO - AFRODITE MIR4","Pedido: "+(payload.pedido_id||"—"),"Pacote: "+(payload.pacote||"—"),"Valor: "+(payload.valor_total||"—"),"Servidor: "+(payload.servidor||"—"),"Acesse o Painel Admin para entregar!"].join("\n")
  : ["💬 NOVA MENSAGEM NO CHAT - AFRODITE MIR4","Cliente: "+(payload.cliente_nome||"Cliente"),"Mensagem: \""+String(payload.mensagem||"").slice(0,1000)+"\"","Acesse o Painel Admin para responder!"].join("\n");
 const task=(async()=>{try{const response=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text})});if(!response.ok)console.error("Telegram notification failed",{status:response.status,body:(await response.text()).slice(0,300)});}catch(error){console.error("Telegram notification error",{message:error?.message||"unknown"})}})();
 if(typeof context.waitUntil==="function")context.waitUntil(task);else await task;
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
   if(selected){
    const rawMsgs=await db(env,"mensagens?select=id,atendimento_id,remetente,texto,criado_em&atendimento_id=eq."+encodeURIComponent(selected)+"&order=criado_em.asc");
    const msgs=rawMsgs.map(({remetente,...m})=>({...m,referente:remetente}));
    return json({atendimento:atendimentos.find(x=>x.id===selected)||null,mensagens:msgs});
   }
   return json({atendimentos});
  }
  if(request.method==="GET"){
   let token=cookieValue(request,COOKIE),setCookie="";
   if(!token){
    token=b64(crypto.getRandomValues(new Uint8Array(32)));
    const hash=await digest(token),id="AFR-"+crypto.randomUUID();
    await db(env,"atendimentos",{method:"POST",body:JSON.stringify({id,cliente_nome:"Visitante MIR4",status_pedido:"chat_ativo",nao_lidas:0,token_hash:hash})});
    setCookie=sessionCookie(token);
   }
   const hash=await digest(token);
   const found=await db(env,"atendimentos?select=id,cliente_nome,servidor,pacote,valor_total,status_pedido,status_item_mercado&id=not.is.null&token_hash=eq."+encodeURIComponent(hash));
   if(!found.length)return json({error:"Sessão de atendimento inválida."},401);
   const rawMsgs=await db(env,"mensagens?select=id,remetente,texto,criado_em&atendimento_id=eq."+encodeURIComponent(found[0].id)+"&order=criado_em.asc");
   const msgs=rawMsgs.map(({remetente,...m})=>({...m,referente:remetente}));
   return json({atendimento:found[0],mensagens:msgs},200,setCookie?{"Set-Cookie":setCookie}:{});
  }
  if(request.method==="PATCH"){
   if(!await adminValid(request,env))return json({error:"Acesso administrativo não autorizado."},401);
   const body=await request.json().catch(()=>null);
   const atendimentoId=String(body?.atendimento_id||"").trim();
   const nextStatus=String(body?.status_pedido||"").trim();
   const allowed=["pendente","pago","em_andamento","entregue"];
   if(!atendimentoId||!allowed.includes(nextStatus))return json({error:"Informe um pedido e um status válido."},400);
   const rows=await db(env,"atendimentos?select=id,status_pedido,cliente_nome&id=eq."+encodeURIComponent(atendimentoId));
   if(!rows.length)return json({error:"Pedido não encontrado."},404);
   const current=String(rows[0].status_pedido||"chat_ativo");
   const paidStates=["pago","em_andamento","entregue"];
   if(nextStatus==="pago"&&current!=="pago"){
    return json({error:"A situação de pagamento só pode ser confirmada automaticamente pela InfinitePay."},409);
   }
   if(nextStatus==="em_andamento"&&!["pago","em_andamento"].includes(current)){
    return json({error:"Confirme o pagamento pela InfinitePay antes de iniciar a entrega."},409);
   }
   if(nextStatus==="entregue"&&!["pago","em_andamento","entregue"].includes(current)){
    return json({error:"Confirme o pagamento antes de marcar o pedido como entregue."},409);
   }
   if(nextStatus==="pendente"&&paidStates.includes(current)){
    return json({error:"Um pedido pago não pode voltar para pendente."},409);
   }
   if(nextStatus==="pendente"&&current!=="pendente"){
    const pendingPayment=await db(env,"pagamentos_infinitepay?select=order_nsu&status=eq.pendente&itens->>atendimento_id=eq."+encodeURIComponent(atendimentoId)+"&limit=1");
    if(!pendingPayment.length)return json({error:"Não existe pagamento pendente vinculado a este atendimento."},409);
   }
   if(nextStatus===current)return json({ok:true,status_pedido:current,unchanged:true});
   const now=new Date().toISOString();
   await db(env,"atendimentos?id=eq."+encodeURIComponent(atendimentoId),{method:"PATCH",body:JSON.stringify({status_pedido:nextStatus,atualizado_em:now,nao_lidas:1})});
   const labels={pendente:"Pendente",pago:"Pagamento confirmado",em_andamento:"Em andamento",entregue:"Entregue"};
   const text="Atualização do seu pedido: "+labels[nextStatus]+".";
   await db(env,"mensagens",{method:"POST",body:JSON.stringify({atendimento_id:atendimentoId,remetente:"atendente",texto:text})});
   return json({ok:true,status_pedido:nextStatus});
  }
  if(request.method==="POST"){
   const body=await request.json().catch(()=>null);
   if(!body||typeof body.text!=="string"||!body.text.trim()||body.text.length>2000)return json({error:"Mensagem inválida."},400);
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
    const orderId=String(body.order_id||"").trim();
    if(!/^AFR-[0-9a-f-]{36}$/i.test(orderId))return json({error:"Identificador do pedido inválido."},400);
    const paymentRows=await db(env,"pagamentos_infinitepay?select=order_nsu,total_centavos,status,itens&order_nsu=eq."+encodeURIComponent(orderId));
    if(!paymentRows.length)return json({error:"Não encontramos o pagamento deste pedido."},409);
    const payment=paymentRows[0],details=payment.itens||{};
    if(payment.status!=="pago")return json({error:"A InfinitePay ainda não confirmou este pagamento. O pedido não foi enviado."},409);
    if(String(details.atendimento_id||"")!==atendimentoId)return json({error:"Este pagamento não pertence a este atendimento."},403);
    const expectedTotal=Number(details.paid_amount||payment.total_centavos);
    const submittedTotal=Math.round(Number(body.valor_total)*100);
    const expectedPackages=(details.items||[]).map(item=>String(item.name)+" x "+Number(item.quantity)).join(", ");
    if(!Number.isFinite(submittedTotal)||submittedTotal!==expectedTotal||String(body.servidor||"")!==String(details.server||"")||String(body.pacote||"")!==expectedPackages){
     return json({error:"Os dados do pedido não correspondem ao pagamento confirmado. Atualize a página e tente novamente."},409);
    }
    const currentOrder=await db(env,"atendimentos?select=id&id=eq."+encodeURIComponent(atendimentoId));
    if(!currentOrder.length)return json({error:"Atendimento não encontrado."},404);
    if(!text.includes(orderId))return json({error:"O resumo do pedido não contém o identificador de pagamento."},400);
    const duplicate=await db(env,"mensagens?select=id&atendimento_id=eq."+encodeURIComponent(atendimentoId)+"&texto=like.*"+encodeURIComponent(orderId)+"*&limit=1");
    if(duplicate.length)return json({error:"Este pedido já foi enviado ao atendimento."},409);
    const printUrl=String(body.print_url||"");
    const isBase64Print=/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/i.test(printUrl)&&printUrl.length<=3000000;
    let isStoragePrint=false;
    try{const parsed=new URL(printUrl),base=new URL(env.SUPABASE_URL);isStoragePrint=parsed.protocol==="https:"&&parsed.origin===base.origin&&parsed.pathname.startsWith("/storage/v1/object/public/prints-pedidos/")}catch{}
    if(!isBase64Print&&!isStoragePrint)return json({error:"O print enviado é inválido ou não pertence ao Storage da loja."},400);
    const claim=await db(env,"pagamentos_infinitepay?order_nsu=eq."+encodeURIComponent(orderId)+"&status=eq.pago&itens->>pedido_enviado_em=is.null",{method:"PATCH",body:JSON.stringify({itens:{...details,pedido_enviado_em:now}})});
    if(!claim.length)return json({error:"Este pedido já está sendo enviado ou foi concluído anteriormente."},409);
    patch.servidor=String(details.server).slice(0,80);
    patch.pacote=expectedPackages.slice(0,300);
    patch.valor_total=expectedTotal/100;
    patch.status_item_mercado=String(body.status_item_mercado||"").slice(0,100);
    patch.print_url=printUrl;
    patch.status_pedido="pago";
   }
   let inserted;
   try{
    await db(env,"atendimentos?id=eq."+encodeURIComponent(atendimentoId),{method:"PATCH",body:JSON.stringify(patch)});
    const messageRows=referente==="cliente"&&body.order_complete===true
     ? [{atendimento_id:atendimentoId,remetente:referente,texto},{atendimento_id:atendimentoId,remetente:referente,texto:"PRINT_URL:"+patch.print_url,criado_em:new Date(Date.now()+1).toISOString()}]
     : {atendimento_id:atendimentoId,remetente:referente,texto};
    inserted=await db(env,"mensagens",{method:"POST",body:JSON.stringify(messageRows)});
   }catch(error){
    if(referente==="cliente"&&body.order_complete===true){
     const orderId=String(body.order_id||"");
     const paymentRows=await db(env,"pagamentos_infinitepay?select=itens&order_nsu=eq."+encodeURIComponent(orderId)).catch(()=>[]);
     if(paymentRows[0]?.itens){
      const restored={...paymentRows[0].itens};delete restored.pedido_enviado_em;
      await db(env,"pagamentos_infinitepay?order_nsu=eq."+encodeURIComponent(orderId),{method:"PATCH",body:JSON.stringify({itens:restored})}).catch(()=>{});
     }
    }
    throw error;
   }
   const mensagem=inserted?.[0]?(({remetente,...m})=>({...m,referente:remetente}))(inserted[0]):null;
   if(referente==="cliente"){
    const alertText="🔔 Novo atendimento/mensagem no site Afrodite MIR4! Acesse o Painel Admin para responder e entregar.";
    if(typeof context.waitUntil==="function")context.waitUntil(sendWhatsappAlert(env,alertText));else await sendWhatsappAlert(env,alertText);
    const tipo=body.order_complete===true?"novo_pedido":"mensagem";
    let shouldNotifyTelegram=true;
    if(tipo==="mensagem"){
     try{
      const recent=await db(env,"mensagens?select=criado_em&atendimento_id=eq."+encodeURIComponent(atendimentoId)+"&remetente=eq.cliente&order=criado_em.desc&limit=2");
      const previous=recent?.[1]?.criado_em?Date.parse(recent[1].criado_em):0;
      if(previous&&Date.now()-previous<120000)shouldNotifyTelegram=false;
     }catch(error){console.error("Telegram chat throttle lookup failed",{message:error?.message||"unknown"});shouldNotifyTelegram=false;}
    }
    if(shouldNotifyTelegram)await sendTelegramAlert(env,{tipo,pedido_id:body.order_id||atendimentoId,cliente_nome:body.cliente_nome||"Cliente Afrodite",servidor:body.servidor||"",pacote:body.pacote||"",valor_total:body.valor_total?Number(body.valor_total).toLocaleString("pt-BR",{style:"currency",currency:"BRL"}):"",mensagem:text},context);
   }
   return json({ok:true,mensagem,order_saved:referente==="cliente"&&body.order_complete===true});
  }
  return json({error:"Método não permitido."},405);
 }catch(e){return fail(e)}
}
