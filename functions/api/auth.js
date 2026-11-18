const COOKIE = "afrodite_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store, private", ...headers } });
}
function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replaceAll("+", "-").replaceAll("/", "_");
}
function fromB64url(value) {
  const base = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base + "=".repeat((4 - base.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}
function safeEqual(a, b) {
  const aa = encoder.encode(String(a)), bb = encoder.encode(String(b));
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) diff |= (aa[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}
async function makeToken(env) {
  const payload = b64url(encoder.encode(JSON.stringify({ user: env.ADMIN_USER, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })));
  return payload + "." + await sign(payload, env.ADMIN_PASSWORD);
}
async function validSession(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const entry = cookie.split(";").map(v => v.trim()).find(v => v.startsWith(COOKIE + "="));
  if (!entry) return false;
  try {
    const token = decodeURIComponent(entry.slice(COOKIE.length + 1));
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return false;
    if (!safeEqual(signature, await sign(payload, env.ADMIN_PASSWORD))) return false;
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return data.user === env.ADMIN_USER && Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
function cookie(value, maxAge) {
  return COOKIE + "=" + value + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + maxAge;
}
export async function onRequest({ request, env }) {
  if (!env.ADMIN_USER || !env.ADMIN_PASSWORD) return json({ error: "A autenticação ainda não foi configurada no servidor." }, 503);
  const url = new URL(request.url);
  if (url.origin !== new URL(request.url).origin) return json({ error: "Origem inválida." }, 403);
  if (request.method === "GET") {
    const authenticated = await validSession(request, env);
    return json({ authenticated });
  }
  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Requisição inválida." }, 400); }
    const usernameOk = safeEqual(body.username || "", env.ADMIN_USER);
    const passwordOk = safeEqual(body.password || "", env.ADMIN_PASSWORD);
    if (!usernameOk || !passwordOk) return json({ error: "Usuário ou senha incorretos." }, 401);
    const token = await makeToken(env);
    return json({ authenticated: true }, 200, { "Set-Cookie": cookie(encodeURIComponent(token), SESSION_SECONDS) });
  }
  if (request.method === "DELETE") {
    return json({ authenticated: false }, 200, { "Set-Cookie": cookie("", 0) });
  }
  return json({ error: "Método não permitido." }, 405, { Allow: "GET, POST, DELETE" });
}