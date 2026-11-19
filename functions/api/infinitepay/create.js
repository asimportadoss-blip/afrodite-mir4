const HANDLE = "amanda-roberta-wt8";
const CATALOG = {
  "1.053 Ouro MIR4": 2000,
  "5.265 Ouro MIR4": 9500,
  "10.530 Ouro MIR4": 19000,
  "21.060 Ouro MIR4": 38000
};
const json = (data, status=200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store" }
});
async function supabase(env, path, options={}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Banco de dados não configurado.");
  const response = await fetch(env.SUPABASE_URL + "/rest/v1/" + path, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type":"application/json",
      Prefer:"return=representation",
      ...(options.headers || {})
    }
  });
  const raw = await response.text();
  let data; try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error("Falha ao registrar o pedido no banco.");
  return data;
}
export async function onRequest({request, env}) {
  if (request.method !== "POST") return json({error:"Método não permitido."},405);
  let row;
  try {
    if (!env.INFINITEPAY_API_KEY) return json({error:"A integração de cartão ainda não está configurada."},503);
    const body = await request.json();
    const atendimento_id = String(body.atendimento_id || "").trim();
    if (!atendimento_id) return json({error:"Não foi possível vincular o pagamento ao seu atendimento. Atualize a página e tente novamente."},400);
    if (!Array.isArray(body.items) || !body.items.length || !["SA1","NA1","INMENA1"].includes(body.server)) return json({error:"Pedido inválido."},400);
    const attendance = await supabase(env,"atendimentos?select=id&id=eq."+encodeURIComponent(atendimento_id));
    if (!attendance.length) return json({error:"Atendimento não encontrado. Atualize a página e tente novamente."},404);
    const items = [];
    let total = 0;
    for (const item of body.items) {
      const name = String(item.name || "");
      const quantity = Number(item.qty);
      if (!Object.prototype.hasOwnProperty.call(CATALOG,name) || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return json({error:"Um dos itens do pedido é inválido."},400);
      const price = CATALOG[name];
      total += price * quantity;
      items.push({name, quantity, price});
    }
    if (!Number.isSafeInteger(total) || total < 1 || total > 10000000) return json({error:"Valor do pedido inválido."},400);
    const order_nsu = "AFR-" + crypto.randomUUID();
    const origin = new URL(request.url).origin;
    row = {order_nsu,total_centavos:total,itens:{server:body.server,atendimento_id,items:items.map(x=>({name:x.name,quantity:x.quantity,price_centavos:x.price}))},status:"pendente"};
    await supabase(env,"pagamentos_infinitepay",{method:"POST",body:JSON.stringify(row)});
    const payload = {
      handle: HANDLE,
      items: items.map(x=>({quantity:x.quantity,price:x.price,description:x.name+" — Servidor "+body.server})),
      order_nsu,
      redirect_url: "https://afrodite-mir4.pages.dev/checkout/retorno?order_nsu="+encodeURIComponent(order_nsu)+"&pedido_id="+encodeURIComponent(order_nsu),
      webhook_url: "https://afrodite-mir4.pages.dev/api/infinitepay-webhook",
      options: { payment_methods_enabled:["pix"], assured_installments:0, require_delivery_address:false }
    };
    const response = await fetch("https://api.checkout.infinitepay.io/links",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Api-Key":env.INFINITEPAY_API_KEY},
      body:JSON.stringify(payload)
    });
    const rawResponse = await response.text();
    let data = null;
    try { data = rawResponse ? JSON.parse(rawResponse) : null; } catch { data = null; }
    let checkoutUrl = null;
    let urlProblem = "";
    if (typeof data?.url === "string" && data.url) {
      try { checkoutUrl = new URL(data.url); }
      catch { urlProblem = "O campo url retornado não contém um endereço válido."; }
    }
    const validUrl = checkoutUrl && checkoutUrl.protocol === "https:" && ["checkout.infinitepay.com.br","checkout.infinitepay.io"].includes(checkoutUrl.hostname);
    if (!response.ok || !validUrl) {
      await supabase(env,"pagamentos_infinitepay?order_nsu=eq."+encodeURIComponent(order_nsu),{method:"PATCH",body:JSON.stringify({status:"erro"})}).catch(()=>{});
      const providerMessage = [data?.message, data?.error, data?.detail].find(value => typeof value === "string" && value.trim());
      const reason = !response.ok
        ? "A InfinitePay respondeu HTTP " + response.status + (providerMessage ? ": " + providerMessage.slice(0,240) : ".")
        : urlProblem || (checkoutUrl ? "A InfinitePay retornou um domínio de checkout inesperado: " + checkoutUrl.hostname : "A resposta da InfinitePay não contém o campo url.");
      console.error("InfinitePay link creation failed", {status:response.status, responseFields:data && typeof data === "object" ? Object.keys(data) : [], reason});
      return json({error:reason},502);
    }
    if(row.itens.atendimento_id){
      const packages=items.map(item=>item.name+" x "+item.quantity).join(", ");
      await supabase(env,"atendimentos?id=eq."+encodeURIComponent(row.itens.atendimento_id),{method:"PATCH",body:JSON.stringify({status_pedido:"pendente",servidor:body.server,pacote:packages,valor_total:total/100,atualizado_em:new Date().toISOString()})}).catch(error=>console.error("Could not mark attendance as pending",{message:error?.message||"unknown"}));
    }
    return json({url:checkoutUrl.href,order_nsu});
  } catch (error) {
    if (row?.order_nsu) await supabase(env,"pagamentos_infinitepay?order_nsu=eq."+encodeURIComponent(row.order_nsu),{method:"PATCH",body:JSON.stringify({status:"erro"})}).catch(()=>{});
    return json({error:"Não foi possível iniciar o pagamento com cartão. Tente novamente."},500);
  }
}