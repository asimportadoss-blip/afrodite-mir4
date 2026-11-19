const COOKIE="afrodite_chat_session";
const enc=new TextEncoder();
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store, private"}});
async function digest(value){
 const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",enc.encode(value)));
 let binary="";for(const b of bytes)binary+=String.fromCharCode(b);
 return btoa(binary).replace(/=/g,"").replaceAll("+","-").replaceAll("/","_");
}
function cookieValue(request){
 const row=(request.headers.get("Cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(COOKIE+"="));
 return row?decodeURIComponent(row.slice(COOKIE.length+1)):"";
}
async function db(env,path){
 const response=await fetch(env.SUPABASE_URL+"/rest/v1/"+path,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY}});
 const raw=await response.text();let data;try{data=raw?JSON.parse(raw):null}catch{data=raw}
 if(!response.ok)throw new Error("Falha ao validar atendimento no Supabase.");
 return data;
}
export async function onRequest({request,env}){
 if(request.method!=="POST")return json({error:"Método não permitido."},405);
 try{
  if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY)return json({error:"Armazenamento de imagens não configurado."},503);
  const token=cookieValue(request);
  if(!token)return json({error:"Abra novamente o atendimento antes de enviar o print."},401);
  const body=await request.json();
  const atendimentoId=String(body.atendimento_id||"").trim();
  const match=String(body.image_data||"").match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+=*)$/i);
  if(!match)return json({error:"A imagem selecionada é inválida."},400);
  const mime=match[1].toLowerCase(),base64=match[2],binary=atob(base64);
  const bytes=new Uint8Array(binary.length);
  if(bytes.length>2*1024*1024)return json({error:"A imagem deve ter no máximo 2 MB."},413);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  const hash=await digest(token);
  const attendance=await db(env,"atendimentos?select=id&id=eq."+encodeURIComponent(atendimentoId)+"&token_hash=eq."+encodeURIComponent(hash));
  if(!attendance||!attendance.length)return json({error:"Atendimento não autorizado para este envio."},403);
  const bucket="prints-pedidos",base=env.SUPABASE_URL.replace(/\/$/,"");
  const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY,"Content-Type":"application/json"};
  try{
   const bucketResponse=await fetch(base+"/storage/v1/bucket",{method:"POST",headers,body:JSON.stringify({id:bucket,name:bucket,public:true,file_size_limit:2097152,allowed_mime_types:["image/jpeg","image/png","image/webp","image/gif"]})});
   if(!bucketResponse.ok&&bucketResponse.status!==409)console.warn("Storage bucket setup failed",{status:bucketResponse.status,details:(await bucketResponse.text()).slice(0,200)});
   const bucketUpdate=await fetch(base+"/storage/v1/bucket/"+bucket,{method:"PUT",headers,body:JSON.stringify({public:true,file_size_limit:2097152,allowed_mime_types:["image/jpeg","image/png","image/webp","image/gif"]})});
   if(!bucketUpdate.ok)console.warn("Storage bucket public setting could not be confirmed",{status:bucketUpdate.status,details:(await bucketUpdate.text()).slice(0,200)});
   const ext={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif"}[mime];
   const objectPath=encodeURIComponent(atendimentoId)+"/"+crypto.randomUUID()+"."+ext;
   const uploaded=await fetch(base+"/storage/v1/object/"+bucket+"/"+objectPath,{method:"POST",headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY,"Content-Type":mime,"x-upsert":"false"},body:bytes});
   if(!uploaded.ok)throw new Error("Storage upload HTTP "+uploaded.status+": "+(await uploaded.text()).slice(0,200));
   return json({success:true,url:base+"/storage/v1/object/public/"+bucket+"/"+objectPath,storage:"supabase"});
  }catch(error){
   console.error("Print Storage upload failed; using Base64 fallback",{message:error?.message||"unknown"});
   return json({success:true,url:"data:"+mime+";base64,"+base64,storage:"base64_fallback",warning:"A imagem foi preservada no atendimento, mas não pôde ser enviada ao Storage."});
  }
 }catch(error){
  console.error("Print upload endpoint failed",{message:error?.message||"unknown"});
  return json({error:"Não foi possível preparar o print. Tente novamente."},500);
 }
}
