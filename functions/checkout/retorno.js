export async function onRequest({request}) {
  const incoming=new URL(request.url);
  const destination=new URL("/",incoming.origin);
  incoming.searchParams.forEach((value,key)=>destination.searchParams.set(key,value));
  destination.searchParams.set("infinitepay","return");
  destination.searchParams.set("retorno_pagamento","1");
  return Response.redirect(destination.toString(),302);
}
