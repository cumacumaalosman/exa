// server.ts
// Deno Deploy entrypoint — proxy + cookie rewriting + forced Origin/Referer to target host

const TARGET_HOST = "https://ecsc-expat.sy:8443"; // target (keep protocol+host+port)
const DEFAULT_FETCH_TIMEOUT = 9000; // ms
const TRY_HTTP_FALLBACK = true; // اجعل false إذا لا تريد تجربة http fallback

// ---------------------- utilities ----------------------
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
  // remove Domain=... so cookie becomes host-only for our domain
  return setCookieValue.replace(/;\s*Domain=[^;]+/i, "");
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as any)[c]);
}

// ---------------------- mimic headers ----------------------
function makeBrowserLikeHeaders(originalReq: Request, targetOrigin: string) {
  // Use some headers from original request where sensible, but force Origin/Referer to target
  const headers = new Headers();
  const ua = originalReq.headers.get("user-agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
  headers.set("User-Agent", ua);
  headers.set("Accept", originalReq.headers.get("accept") || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  headers.set("Accept-Language", originalReq.headers.get("accept-language") || "en-US,en;q=0.9");
  // Force origin/referer to target host/origin as requested
  headers.set("Origin", targetOrigin);
  headers.set("Referer", targetOrigin + "/");
  // Sec-Fetch headers commonly seen in browser navigation/fetch
  headers.set("Sec-Fetch-Site", "same-site");
  headers.set("Sec-Fetch-Mode", "navigate");
  headers.set("Sec-Fetch-Dest", "document");
  headers.set("Sec-Fetch-User", "?1");
  // We keep content-type from original for POSTs if present
  const ct = originalReq.headers.get("content-type");
  if (ct) headers.set("Content-Type", ct);
  return headers;
}

// ---------------------- fetch with fallback ----------------------
async function tryFetchWithFallback(init: RequestInit, targetUrlHttps: string) {
  try {
    console.log("Attempting fetch ->", targetUrlHttps);
    const r = await timeoutFetch(targetUrlHttps, init);
    return { resp: r, url: targetUrlHttps };
  } catch (err) {
    console.warn("HTTPS fetch failed:", String(err));
    if (TRY_HTTP_FALLBACK) {
      try {
        const u = new URL(targetUrlHttps);
        u.protocol = "http:";
        const httpUrl = u.toString();
        console.log("Attempting HTTP fallback ->", httpUrl);
        const r2 = await timeoutFetch(httpUrl, init);
        return { resp: r2, url: httpUrl };
      } catch (err2) {
        console.warn("HTTP fallback failed:", String(err2));
        const e = new Error(`Both https and http fetch failed. https error: ${String(err)}; http error: ${String(err2)}`);
        (e as any).cause = { httpsErr: err, httpErr: err2 };
        throw e;
      }
    }
    throw err;
  }
}

// ---------------------- proxy helper ----------------------
async function proxyToTarget(req: Request, targetUrl: string): Promise<Response> {
  // Prepare RequestInit: mimic browser headers and forward body
  const targetOrigin = (new URL(TARGET_HOST)).origin;
  const forwardHeaders = makeBrowserLikeHeaders(req, targetOrigin);

  // Ensure Host header for SNI/virtual-hosting
  try { forwardHeaders.set("Host", (new URL(TARGET_HOST)).host); } catch(_) {}

  // For non-GET/HEAD, forward body
  const init: RequestInit = {
    method: req.method,
    headers: forwardHeaders,
    redirect: "manual",
    body: ["GET","HEAD"].includes(req.method) ? undefined : req.body
  };

  let upstream: Response;
  try {
    const { resp } = await tryFetchWithFallback(init, targetUrl);
    upstream = resp!;
  } catch (err) {
    console.error("Upstream unreachable:", err);
    const errHtml = `
      <!doctype html><html><head><meta charset="utf-8"><title>Upstream unreachable</title></head><body>
      <h2>خطأ في الوصول إلى الخادم الهدف</h2>
      <p>لم أستطع الوصول إلى: <strong>${escapeHtml(targetUrl)}</strong></p>
      <pre>${escapeHtml(String(err))}</pre>
      <p>جرب فتح الرابط الهدف مباشرة أو تأكد من أن المنصة التي تستعملها تسمح بالوصول إلى منافذ غير قياسية (مثل 8443).</p>
      <p><a href="${TARGET_HOST}" target="_blank" rel="noopener">فتح العنوان الهدف في نافذة جديدة</a></p>
      </body></html>
    `;
    return textResponse(req, errHtml, 502);
  }

  // Build outgoing headers — include CORS and forward Set-Cookie(s) (rewritten)
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
    let text = await upstream.text();
    // rewrite occurrences of the absolute TARGET_HOST -> relative so assets load under our domain
    const escaped = TARGET_HOST.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    const re1 = new RegExp(escaped, "g");
    text = text.replace(re1, "");
    const hostOrigin = (new URL(TARGET_HOST)).origin;
    const re2 = new RegExp(hostOrigin.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"), "g");
    text = text.replace(re2, "");

    // inject small script to rewrite future navigations pointing to target origin
    const injection = `
<script>
  (function(){
    try {
      const target = ${JSON.stringify(new URL(TARGET_HOST).origin)};
      const _assign = location.assign; location.assign = function(u){ if(typeof u==='string' && u.indexOf(target)===0) u = u.replace(target,''); _assign.call(location,u); };
      const _replace = location.replace; location.replace = function(u){ if(typeof u==='string' && u.indexOf(target)===0) u = u.replace(target,''); _replace.call(location,u); };
    }catch(e){}
  })();
</script>
`;
    if (text.includes("</head>")) text = text.replace("</head>", injection + "</head>");
    else if (text.includes("</body>")) text = text.replace("</body>", injection + "</body>");
    else text = injection + text;

    outHeaders.set("content-type", "text/html; charset=utf-8");
    return new Response(text, { status: upstream.status, headers: outHeaders });
  } else {
    const buf = await upstream.arrayBuffer();
    if (contentType) outHeaders.set("content-type", contentType);
    return new Response(buf, { status: upstream.status, headers: outHeaders });
  }
}

// ---------------------- handler ----------------------
async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const pathname = url.pathname || "/";

    // OPTIONS preflight
    if (req.method === "OPTIONS") return corsPreflightResponse(req);

    // Health
    if (req.method === "GET" && pathname === "/health") return jsonResponse(req, { ok: true, now: new Date().toISOString() }, 200);

    // Serve UI at /app
    if (req.method === "GET" && pathname === "/app") return textResponse(req, getHTML(), 200);

    // LOGIN: proxy to target login but force Origin/Referer and forward Set-Cookie(s)
    if (req.method === "POST" && pathname === "/login") {
      try {
        const body = await req.json();
        const targetOrigin = (new URL(TARGET_HOST)).origin;
        const headers = makeBrowserLikeHeaders(req, targetOrigin);
        try { headers.set("Host", (new URL(TARGET_HOST)).host); } catch(_) {}

        const init: RequestInit = {
          method: "POST",
          headers,
          redirect: "manual",
          body: JSON.stringify({ username: body.username, password: body.password })
        };

        const { resp: upstream } = await tryFetchWithFallback(init, `${TARGET_HOST}/secure/auth/login`);
        if (!upstream) return jsonResponse(req, { ok: false, error: "Upstream timeout" }, 504);

        const resHeaders = new Headers(makeCorsHeaders(req));
        upstream.headers.forEach((v,k)=> {
          if (k.toLowerCase() === "set-cookie") resHeaders.append("set-cookie", rewriteSetCookieForOurDomain(v));
          else if (k.toLowerCase() === "location") {
            try {
              const locUrl = new URL(v, TARGET_HOST);
              const rel = locUrl.pathname + locUrl.search + locUrl.hash;
              resHeaders.set("location", rel);
            } catch(_) { resHeaders.set("location", v); }
          } else if (k.toLowerCase() === "content-type") resHeaders.set("content-type", v);
        });

        const txt = await upstream.text().catch(()=>"");
        return new Response(JSON.stringify({ ok: upstream.ok, upstreamStatus: upstream.status, message: txt||"" }), { status: 200, headers: resHeaders });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResponse(req, { ok: false, error: msg }, 500);
      }
    }

    // RS/ADD: forward cookies and force Origin/Referer
    if (req.method === "POST" && pathname === "/rs/add") {
      try {
        const body = await req.json();
        const cookieHeader = req.headers.get("cookie") || "";
        const targetOrigin = (new URL(TARGET_HOST)).origin;
        const headers = makeBrowserLikeHeaders(req, targetOrigin);
        try { headers.set("Host", (new URL(TARGET_HOST)).host); } catch(_) {}
        if (cookieHeader) headers.set("Cookie", cookieHeader);
        // set Sec-Fetch for XHR
        headers.set("Sec-Fetch-Site", "same-site");
        headers.set("Sec-Fetch-Mode", "cors");
        headers.set("Sec-Fetch-Dest", "empty");

        const init: RequestInit = {
          method: "POST",
          headers,
          redirect: "manual",
          body: JSON.stringify({
            missionId: parseInt(body.missionId || body.city || 0, 10),
            serviceId: parseInt(body.serviceId || body.service || 113, 10),
            copies: parseInt(body.copies || 1, 10),
            date: body.date === "" ? null : (body.date || null)
          })
        };

        const { resp: upstream } = await tryFetchWithFallback(init, `${TARGET_HOST}/rs/add`);
        if (!upstream) return jsonResponse(req, { ok: false, error: "Upstream timeout" }, 504);

        const resHeaders = new Headers(makeCorsHeaders(req));
        upstream.headers.forEach((v,k)=> { if (k.toLowerCase()==="set-cookie") resHeaders.append("set-cookie", rewriteSetCookieForOurDomain(v)); });

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

    // fallback: proxy everything else (includes GET /)
    const targetUrl = TARGET_HOST.replace(/\/+$/, "") + pathname + url.search;
    return await proxyToTarget(req, targetUrl);

  } catch (err) {
    return jsonResponse(req, { ok: false, error: (err instanceof Error ? err.message : String(err)) }, 500);
  }
}

// ---------------------- start server ----------------------
const port = Number(Deno.env.get("PORT") || 8000);
console.log(`Starting server (Deno) — port ${port} — TARGET_HOST=${TARGET_HOST}`);
Deno.serve({ port }, handler);

// ---------------------- client HTML (runs in browser) ----------------------
// Note: client uses credentials: 'include' for /login and /rs/add
function getHTML(): string {
  return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Jumaa</title></head><body>
<p>واجهة التطبيق متاحة على <a href="/app">/app</a></p>
</body></html>`;
}
