// main.ts — Deno Deploy reverse proxy for https://ecsc-expat.sy:8443
// ⚠️ لا تستخدم أي server.listen — Deno Deploy يستدعي handler تلقائيًا.

const TARGET = "https://ecsc-expat.sy:8443"; // بدّله لـ https://ecsc-expat.sy لو احتجت 443

// ============ أدوات مساعدة ============
function corsPreflight(origin?: string) {
  const o = origin || "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": o,
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function rewriteSetCookie(sc: string) {
  // احذف Domain=.. حتى تنحفظ الكوكي على دومينك
  let out = sc.replace(/;\s*Domain=[^;]*/gi, "");
  // تأكد من وجود Path=/
  if (!/;\s*Path=/i.test(out)) out += "; Path=/";
  return out;
}

function makeBrowserishHeaders(req: Request, targetUrl: URL, pathForReferer: string) {
  const h = new Headers();

  // انقل بعض الهيدرز المفيدة من طلب العميل
  const ua = req.headers.get("user-agent") || "Mozilla/5.0";
  const al = req.headers.get("accept-language") || "en-US,en;q=0.9";
  const acc = req.headers.get("accept") || "*/*";
  const ct = req.headers.get("content-type");

  h.set("User-Agent", ua);
  h.set("Accept-Language", al);
  h.set("Accept", acc);
  if (ct) h.set("Content-Type", ct);

  // أهم شيء: أظهر أن الطلب صادر من المضيف الأصلي
  const origin = `${targetUrl.protocol}//${targetUrl.hostname}`;
  h.set("Origin", origin);
  h.set("Referer", origin + pathForReferer);

  // رؤوس إضافية (قد تُتجاهل من runtime لكن لا تضر)
  h.set("Sec-Fetch-Site", "same-site");
  h.set("Sec-Fetch-Mode", "cors");
  h.set("Sec-Fetch-Dest", "empty");
  h.set("Alt-Used", targetUrl.hostname);

  // لا تحاول ضبط Host — runtime بيحددها من URL
  return h;
}

function buildProxiedUrl(reqUrl: URL): URL {
  const t = new URL(TARGET);
  t.pathname = reqUrl.pathname;
  t.search = reqUrl.search;
  return t;
}

function rewriteLocationHeader(v: string) {
  try {
    const t = new URL(TARGET);
    const loc = new URL(v, t); // يدعم القيم النسبية والمطلقة
    if (loc.origin === t.origin) {
      return loc.pathname + loc.search + loc.hash; // خليها نسبية لدوّمنك
    }
    return v; // لو أصل مختلف، اتركها كما هي
  } catch {
    return v;
  }
}

function needsHtmlRewrite(contentType: string | null) {
  return !!contentType && contentType.toLowerCase().includes("text/html");
}

function rewriteHtml(html: string) {
  // أزل الأصل المطلق ليصير مسار نسبي تحت نفس الدومين
  const t = new URL(TARGET);
  const origin = t.origin.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const full = TARGET.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  let out = html.replace(new RegExp(full, "g"), "").replace(new RegExp(origin, "g"), "");

  // حقن سكربت يمنع location.assign/replace من القفز للدومين الأصلي
  const inject = `
<script>
(function(){
  try{
    const target = ${JSON.stringify(new URL(TARGET).origin)};
    const _a = location.assign.bind(location);
    location.assign = (u)=>{ if(typeof u==='string' && u.startsWith(target)) u=u.replace(target,''); _a(u); };
    const _r = location.replace.bind(location);
    location.replace = (u)=>{ if(typeof u==='string' && u.startsWith(target)) u=u.replace(target,''); _r(u); };
  }catch(e){}
})();
</script>`;
  if (out.includes("</head>")) out = out.replace("</head>", inject + "</head>");
  else if (out.includes("</body>")) out = out.replace("</body>", inject + "</body>");
  else out = inject + out;

  return out;
}

// ============ المعالج الرئيسي ============
addEventListener("fetch", (ev) => ev.respondWith(handle(ev.request)));

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // CORS preflight
  if (req.method === "OPTIONS") {
    return corsPreflight(req.headers.get("Origin") || undefined);
  }

  // نبني عنوان الوجهة
  const targetUrl = buildProxiedUrl(url);

  // رؤوس تشبه المتصفح وتُظهر أن الطلب من الأصل
  const fwdHeaders = makeBrowserishHeaders(req, targetUrl, url.pathname);

  // مرّر كوكي العميل (المحفوظة على دومينك) للهدف
  const cookie = req.headers.get("cookie");
  if (cookie) fwdHeaders.set("Cookie", cookie);

  // حضّر جسم الطلب (لا تقرأه مرتين)
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : req.body;

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: fwdHeaders,
      body,
      redirect: "manual",
    });
  } catch (e) {
    return new Response("Bad gateway: " + String(e), { status: 502 });
  }

  // جهّز رؤوس الاستجابة (مع CORS وSet-Cookie وLocation)
  const out = new Headers();

  // مرّر نوع المحتوى + أي رؤوس مهمة
  const ct = upstream.headers.get("content-type");
  if (ct) out.set("content-type", ct);

  // Location → اعملها نسبية إذا كانت تشير للأصل الهدف
  const loc = upstream.headers.get("location");
  if (loc) out.set("location", rewriteLocationHeader(loc));

  // اكتب كل Set-Cookie بعد إعادة صياغتها (إزالة Domain)
  const setCookies: string[] = [];
  upstream.headers.forEach((v, k) => {
    if (k.toLowerCase() === "set-cookie") setCookies.push(v);
  });
  for (const sc of setCookies) {
    out.append("set-cookie", rewriteSetCookie(sc));
  }

  // CORS — حتى لو الصفحة نفس الأصل، ما بيضر
  const reqOrigin = req.headers.get("Origin");
  if (reqOrigin) {
    out.set("Access-Control-Allow-Origin", reqOrigin);
    out.set("Access-Control-Allow-Credentials", "true");
    out.append("Vary", "Origin");
  } else {
    out.set("Access-Control-Allow-Origin", "*");
    out.set("Access-Control-Allow-Credentials", "true");
  }
  out.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  out.set("Access-Control-Allow-Headers", "*");
  out.set("Access-Control-Expose-Headers", "*");

  // HTML: نعيد كتابة الروابط المطلقة + حقن سكربت
  if (needsHtmlRewrite(ct)) {
    const text = await upstream.text();
    const rewritten = rewriteHtml(text);
    out.set("content-type", "text/html; charset=utf-8");
    return new Response(rewritten, { status: upstream.status, statusText: upstream.statusText, headers: out });
  }

  // خلاف ذلك: مرّر الجسم كما هو (stream)
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}
