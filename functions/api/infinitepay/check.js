const DEFAULT_HANDLE = "amanda-roberta-wt8";
const json = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
async function db(env,path,options={}) {
  if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Banco de dados não configurado.");
  const response=await fetch(env.SUPABASE_URL+"/rest/v1/"+path,{...options,headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:"Bearer "+env.SUPABASE_SERVICE_ROLE_KEY,"Content-Type":"application/json",...(options.headers||{})}});
  const raw=await response.text();let data;try{data=raw?JSON.parse(raw):null}catch{data=raw}
  if(!response.ok) throw new Error("Supabase HTTP "+response.status+": "+String(raw).slice(0,500));
  return data;
}
export async function onRequest({request,env}) {
  if(request.method!=="POST") return json({error:"Método não permitido."},405);
  let body={};
  try {
    body=await request.json();
    const orderNsu=String(body.order_nsu||body.pedido_id||body.pedidoId||body.id||"").trim();
    const transactionNsu=String(body.transaction_nsu||body.transaction_id||body.transactionId||"").trim();
    const slug=String(body.slug||"").trim();
    const handle=String(body.handle||env.INFINITEPAY_HANDLE||DEFAULT_HANDLE).replace(/^\$/,"").trim();
    if(!orderNsu&&!transactionNsu) return json({error:"Informe order_nsu ou transaction_nsu.",received_fields:Object.keys(body||{})},400);

    // A InfinitePay é consultada antes de qualquer busca no Supabase.
    const sent={handle,order_nsu:orderNsu||undefined,transaction_nsu:transactionNsu||undefined,slug:slug||undefined};
    const response=await fetch("https://api.infinitepay.io/invoices/public/checkout/payment_check",{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(sent)
    });
    const raw=await response.text();let result;try{result=raw?JSON.parse(raw):null}catch{result={raw_response:raw};}
    const diagnostic={enviado:sent,resposta_http:response.status,resposta:result};
    console.log("InfinitePay check diagnostic",{http_status:response.status,paid:result?.paid??null,success:result?.success??null,has_order:!!orderNsu,has_transaction:!!transactionNsu,has_slug:!!slug});
    if(!response.ok||result?.paid!==true) {
      return json({paid:false,pending:true,error:!response.ok?"A InfinitePay respondeu HTTP "+response.status+".":"A InfinitePay ainda não confirmou o pagamento.",infinitepay_raw:result,diagnostic},response.ok?409:502);
    }

    // Só paid=true comprova pagamento. success=true isoladamente não libera pedido.
    const now=new Date().toISOString();
    let paymentRows=[];
    if(orderNsu) paymentRows=await db(env,"pagamentos_infinitepay?select=order_nsu,total_centavos,status,itens&order_nsu=eq."+encodeURIComponent(orderNsu)).catch(error=>{console.error("Busca auxiliar do pagamento falhou",error.message);return [];});
    if(!paymentRows.length&&transactionNsu) paymentRows=await db(env,"pagamentos_infinitepay?select=order_nsu,total_centavos,status,itens&transaction_nsu=eq."+encodeURIComponent(transactionNsu)).catch(()=>[]);
    const payment=paymentRows[0]||null;
    if(payment?.total_centavos!=null&&Number(result.amount)!==Number(payment.total_centavos)) {
      return json({paid:false,pending:true,error:"O pagamento foi localizado, mas o valor não confere com o pedido.",infinitepay_raw:result,diagnostic:{...diagnostic,valor_esperado_centavos:Number(payment.total_centavos),valor_recebido_centavos:Number(result.amount)}},409);
    }
    const atendimentoId=payment?.itens?.atendimento_id||null;
    let attendanceUpdated=false;
    const attendanceId=atendimentoId||(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderNsu)?orderNsu:null);
    if(attendanceId) {
      const attendancePayload={id:attendanceId,status_pedido:"pago",atualizado_em:now};
      const server=payment?.itens?.server;
      const items=payment?.itens?.items;
      if(server) attendancePayload.servidor=server;
      if(Array.isArray(items)) attendancePayload.pacote=items.map(x=>x.name+" x "+x.quantity).join(", ");
      if(result.paid_amount!=null||result.amount!=null) attendancePayload.valor_total=Number(result.paid_amount??result.amount)/100;
      await db(env,"atendimentos?on_conflict=id",{method:"POST",headers:{Prefer:"resolution=merge-duplicates,return=representation"},body:JSON.stringify(attendancePayload)});
      attendanceUpdated=true;
    }
    if(payment) {
      await db(env,"pagamentos_infinitepay?order_nsu=eq."+encodeURIComponent(payment.order_nsu),{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({status:"pago",transaction_nsu:transactionNsu||null,invoice_slug:slug||null,confirmado_em:now,itens:{...payment.itens,capture_method:result.capture_method||body.capture_method||null,paid_amount:Number(result.paid_amount??result.amount)}})}).catch(error=>console.error("Pagamento confirmado na InfinitePay; atualização auxiliar do registro falhou",error.message));
    }
    return json({paid:true,order_nsu:orderNsu,attendance_updated:attendanceUpdated});
  } catch(error) {
    console.error("InfinitePay check internal error",{message:error?.message||"unknown"});
    return json({error:"Não foi possível confirmar ou registrar o pagamento.",detail:error?.message||"unknown"},500);
  }
}
