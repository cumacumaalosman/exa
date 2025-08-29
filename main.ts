// server.ts — improved upstream reachability handling + cookie/CORS support
const TARGET_HOST = "https://ecsc-expat.sy:8443";
const DEFAULT_FETCH_TIMEOUT = 9000; // ms
const TRY_HTTP_FALLBACK = true; // لو تريد تعطّل تجربة http ضع false

function getRequestOrigin(req: Request) {
  return req.headers.get("origin") || req.headers.get("referer") || "*";
}

function makeCorsHeaders(req: Request, extra?: Record<string,string>) {
  const origin = getRequestOrigin(req) || "*";
  const headers: Record<string,string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS,PUT,DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Source, Cookie, Authorization",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Expose-Headers": "Location,Content-Length,Set-Cookie"
  };
  if (extra) Object.assign(headers, extra);
  return headers;
}

function jsonResponse(req: Request, obj: unknown, status = 200, extra?: Record<string,string>) {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", ...makeCorsHeaders(req, extra) });
  return new Response(JSON.stringify(obj), { status, headers });
}

function textResponse(req: Request, text: string, status = 200, extra?: Record<string,string>) {
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", ...makeCorsHeaders(req, extra) });
  return new Response(text, { status, headers });
}

function corsPreflightResponse(req: Request) {
  const headers = new Headers(makeCorsHeaders(req));
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(null, { status: 204, headers });
}

async function timeoutFetch(input: RequestInfo, init?: RequestInit, timeout = DEFAULT_FETCH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(input, { ...(init || {}), signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

function rewriteSetCookieForOurDomain(setCookieValue: string) {
  return setCookieValue.replace(/;\s*Domain=[^;]+/i, "");
}

async function tryFetchWithFallback(reqInit: RequestInit, targetUrlHttps: string) {
  // try HTTPS first (targetUrlHttps), then optional HTTP fallback
  try {
    console.log("Attempting fetch ->", targetUrlHttps);
    const r = await timeoutFetch(targetUrlHttps, reqInit);
    return { resp: r, url: targetUrlHttps };
  } catch (err) {
    console.warn("fetch to https failed:", String(err));
    if (TRY_HTTP_FALLBACK) {
      try {
        // build http fallback url (replace protocol)
        const u = new URL(targetUrlHttps);
        u.protocol = "http:";
        const httpUrl = u.toString();
        console.log("Attempting HTTP fallback ->", httpUrl);
        const r2 = await timeoutFetch(httpUrl, reqInit);
        return { resp: r2, url: httpUrl };
      } catch (err2) {
        console.warn("http fallback failed:", String(err2));
        // throw combined info
        const e = new Error(`Both https and http fetch failed. https error: ${String(err)}; http error: ${String(err2)}`);
        (e as any).cause = { httpsErr: err, httpErr: err2 };
        throw e;
      }
    }
    throw err;
  }
}

/** proxy helper with robust error handling */
async function proxyToTarget(req: Request, targetUrl: string): Promise<Response> {
  // build forward headers
  const forward = new Headers();
  req.headers.forEach((v, k) => {
    if (["host", "content-length", "accept-encoding", "connection"].includes(k.toLowerCase())) return;
    forward.set(k, v);
  });
  // ensure Host header for SNI/virtual-hosting
  try { forward.set("Host", new URL(TARGET_HOST).host); } catch(_) {}
  forward.set("Referer", TARGET_HOST);
  forward.set("Origin", TARGET_HOST);

  const init: RequestInit = {
    method: req.method,
    headers: forward,
    redirect: "manual",
    body: ["GET","HEAD"].includes(req.method) ? undefined : req.body
  };

  let upstream;
  let usedUrl;
  try {
    const result = await tryFetchWithFallback(init, targetUrl);
    upstream = result.resp;
    usedUrl = result.url;
  } catch (err) {
    console.error("Upstream unreachable:", err);
    // Return an informative HTML page so you can see the error on the browser
    const errHtml = `
      <!doctype html><html><head><meta charset="utf-8"><title>Upstream unreachable</title></head><body>
      <h2>خطأ في الوصول إلى الخادم الهدف</h2>
      <p>لم أستطع الوصول إلى: <strong>${escapeHtml(targetUrl)}</strong></p>
      <p>تفاصيل الخطأ: <pre>${escapeHtml(String(err))}</pre></p>
      <p>ملاحظات شائعة:</p>
      <ul>
        <li>تأكد أن <code>ecsc-expat.sy:8443</code> متاح من شبكة Deno Deploy / المنصة (بعض المنصات تمنع منافذ غير قياسية).</li>
        <li>ربما تحتاج نشر الكود على سيرفر افتراضي (VPS) أو خدمة تدعم الوصول للخوادم الداخلية.</li>
        <li>إذا السيرفر الهدف يعمل على منفذ آخر (مثلاً 443)، جرب تغيير <code>TARGET_HOST</code>.</li>
      </ul>
      <p><a href="${TARGET_HOST}" target="_blank" rel="noopener">فتح العنوان الهدف في نافذة جديدة (مباشر)</a></p>
      </body></html>
    `;
    return textResponse(req, errHtml, 502);
  }

  if (!upstream) return jsonResponse(req, { ok: false, error: "No upstream response" }, 502);

  // prepare outgoing headers preserving Set-Cookie and rewriting Location
  const outHeaders = new Headers(makeCorsHeaders(req));
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk === "set-cookie") {
      outHeaders.append("set-cookie", rewriteSetCookieForOurDomain(v));
    } else if (lk === "location") {
      try {
        const locUrl = new URL(v, TARGET_HOST);
        if (locUrl.origin === (new URL(TARGET_HOST)).origin) {
          const rel = locUrl.pathname + locUrl.search + locUrl.hash;
          outHeaders.set("location", rel);
        } else {
          outHeaders.set("location", v);
        }
      } catch (_) {
        outHeaders.set("location", v);
      }
    } else if (lk === "content-type") {
      outHeaders.set("content-type", v);
    } else {
      outHeaders.append(k, v);
    }
  });

  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const text = await upstream.text();
    // rewrite absolute target references -> relative
    const escaped = TARGET_HOST.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    const re1 = new RegExp(escaped, "g");
    let final = text.replace(re1, "");
    const hostOrigin = (new URL(TARGET_HOST)).origin;
    const re2 = new RegExp(hostOrigin.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"), "g");
    final = final.replace(re2, "");

    const injection = `
<script>
  (function(){
    try {
      const target = ${JSON.stringify(new URL(TARGET_HOST).origin)};
      const _assign = location.assign;
      location.assign = function(u){ if(typeof u==='string' && u.indexOf(target)===0) u = u.replace(target,''); _assign.call(location,u); };
      const _replace = location.replace;
      location.replace = function(u){ if(typeof u==='string' && u.indexOf(target)===0) u = u.replace(target,''); _replace.call(location,u); };
    }catch(e){}
  })();
</script>
`;
    if (final.includes("</head>")) final = final.replace("</head>", injection + "</head>");
    else if (final.includes("</body>")) final = final.replace("</body>", injection + "</body>");
    else final = injection + final;

    outHeaders.set("content-type", "text/html; charset=utf-8");
    return new Response(final, { status: upstream.status, headers: outHeaders });
  } else {
    const buf = await upstream.arrayBuffer();
    if (contentType) outHeaders.set("content-type", contentType);
    return new Response(buf, { status: upstream.status, headers: outHeaders });
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as any)[c]);
}

async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const pathname = url.pathname || "/";

    if (req.method === "OPTIONS") return corsPreflightResponse(req);
    if (req.method === "GET" && pathname === "/health") return jsonResponse(req, { ok: true, now: new Date().toISOString() }, 200);
    if (req.method === "GET" && pathname === "/app") return textResponse(req, getHTML(), 200);

    if (req.method === "POST" && pathname === "/login") {
      try {
        const body = await req.json();
        const init = {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Source": "WEB",
            "Referrer": `${TARGET_HOST}/secure/auth/login`,
            "Host": (new URL(TARGET_HOST)).host
          },
          body: JSON.stringify({ username: body.username, password: body.password }),
          redirect: "manual"
        } as RequestInit;

        const { resp: upstream } = await tryFetchWithFallback(init, `${TARGET_HOST}/secure/auth/login`);
        if (!upstream) return jsonResponse(req, { ok: false, error: "Upstream timeout" }, 504);

        const resHeaders = new Headers(makeCorsHeaders(req));
        upstream.headers.forEach((v,k) => {
          if (k.toLowerCase() === "set-cookie") resHeaders.append("set-cookie", rewriteSetCookieForOurDomain(v));
          else if (k.toLowerCase()==="location") {
            try {
              const locUrl = new URL(v, TARGET_HOST);
              const rel = locUrl.pathname + locUrl.search + locUrl.hash;
              resHeaders.set("location", rel);
            } catch(_) { resHeaders.set("location", v); }
          } else if (k.toLowerCase()==="content-type") resHeaders.set("content-type", v);
        });
        const txt = await upstream.text().catch(()=>"");
        return new Response(JSON.stringify({ ok: upstream.ok, upstreamStatus: upstream.status, message: txt||"" }), { status: 200, headers: resHeaders });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResponse(req, { ok: false, error: msg }, 500);
      }
    }

    if (req.method === "POST" && pathname === "/rs/add") {
      try {
        const body = await req.json();
        const cookieHeader = req.headers.get("cookie") || "";
        const init = {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Source": "WEB",
            "Alt-Used": "ecsc-expat.sy:8443",
            "Sec-Fetch-Site": "same-site",
            "Host": (new URL(TARGET_HOST)).host,
            ...(cookieHeader ? { "Cookie": cookieHeader } : {})
          },
          body: JSON.stringify({
            missionId: parseInt(body.missionId || body.city || 0, 10),
            serviceId: parseInt(body.serviceId || body.service || 113, 10),
            copies: parseInt(body.copies || 1, 10),
            date: body.date === "" ? null : (body.date || null)
          }),
          redirect: "manual"
        } as RequestInit;

        const { resp: upstream } = await tryFetchWithFallback(init, `${TARGET_HOST}/rs/add`);
        if (!upstream) return jsonResponse(req, { ok: false, error: "Upstream timeout" }, 504);

        const resHeaders = new Headers(makeCorsHeaders(req));
        upstream.headers.forEach((v,k) => { if (k.toLowerCase()==="set-cookie") resHeaders.append("set-cookie", rewriteSetCookieForOurDomain(v)); });

        const len = parseInt(upstream.headers.get("content-length") || "0", 10);
        let message = "";
        if (upstream.status === 400 && len === 220) message = "تم حجز كافة المواعيد المخصصة لهذه الخدمة.. يرجى اختيار يوم آخر";
        else if (upstream.status === 400 && len === 165) message = "حظ أوفر لم يتوفر هذا اليوم بعد حاول مرة أخرى";
        else if (upstream.status === 403) message = "انتهت صلاحية الجلسة";
        else if (upstream.status === 400 && [225,189,186].includes(len)) message = "لديك حجز مسبق";
        else if (upstream.status === 200) message = "تم التثبيت بنجاح";
        else message = "استجابة غير متوقعة من الخادم";

        return new Response(JSON.stringify({ ok: upstream.ok, upstreamStatus: upstream.status, message }), { status: 200, headers: resHeaders });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResponse(req, { ok: false, error: msg }, 500);
      }
    }

    // fallback proxy (includes GET /)
    const targetUrl = TARGET_HOST.replace(/\/+$/, "") + pathname + url.search;
    return await proxyToTarget(req, targetUrl);

  } catch (err) {
    return jsonResponse(req, { ok: false, error: (err instanceof Error ? err.message : String(err)) }, 500);
  }
}

// start
const port = Number(Deno.env.get("PORT") || 8000);
console.log(`Starting server (Deno) — port ${port} — TARGET_HOST=${TARGET_HOST}`);
Deno.serve({ port }, handler);

// ------------------- getHTML (client) -------------------
// (as before: client uses credentials: 'include' for /login and /rs/add)
function getHTML(): string {
  return `<!doctype html>... وضع هنا HTML كما في النسخة السابقة ...</html>`;
}
