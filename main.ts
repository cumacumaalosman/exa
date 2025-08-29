// server.ts — Deno Deploy entrypoint (CORS + cookie handling)
const TARGET_HOST = "https://ecsc-expat.sy:8443";
const DEFAULT_FETCH_TIMEOUT = 8000; // ms

function getRequestOrigin(req: Request) {
  return req.headers.get("origin") || req.headers.get("referer") || null;
}

function makeCorsHeaders(req: Request, extra?: Record<string,string>) {
  const origin = getRequestOrigin(req) || "*";
  const headers: Record<string,string> = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS,PUT,DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Source, Cookie, Authorization",
    // allow client to send credentials
    "Access-Control-Allow-Credentials": "true",
    // expose some useful headers if needed
    "Access-Control-Expose-Headers": "Location,Content-Length"
  };
  if (extra) Object.assign(headers, extra);
  return headers;
}

function jsonResponse(req: Request, obj: unknown, status = 200, extraHeaders?: Record<string,string>) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    ...makeCorsHeaders(req, extraHeaders)
  });
  return new Response(JSON.stringify(obj), { status, headers });
}

function textResponse(req: Request, text: string, status = 200, extraHeaders?: Record<string,string>) {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    ...makeCorsHeaders(req, extraHeaders)
  });
  return new Response(text, { status, headers });
}

function corsPreflightResponse(req: Request) {
  const headers = new Headers(makeCorsHeaders(req));
  // Preflight specific
  headers.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(null, { status: 204, headers });
}

async function timeoutFetch(input: RequestInfo, init?: RequestInit, timeout = DEFAULT_FETCH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const signal = controller.signal;
    const res = await fetch(input, { ...(init || {}), signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// Remove Domain=... from Set-Cookie so it becomes host-only for our domain
function rewriteSetCookieForOurDomain(setCookieValue: string) {
  // remove Domain=... (case-insensitive)
  return setCookieValue.replace(/;\s*Domain=[^;]+/i, "");
}

/** Proxy helper: forward request to targetUrl and return response with CORS + rewritten Set-Cookie */
async function proxyToTarget(req: Request, targetUrl: string): Promise<Response> {
  // Build forward headers (copy request headers except hop-by-hop)
  const forward = new Headers();
  req.headers.forEach((v, k) => {
    if (["host", "content-length", "accept-encoding", "connection"].includes(k.toLowerCase())) return;
    forward.set(k, v);
  });
  forward.set("Referer", TARGET_HOST);
  forward.set("Origin", TARGET_HOST);

  const init: RequestInit = {
    method: req.method,
    headers: forward,
    redirect: "manual",
    body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body
  };

  const upstream = await timeoutFetch(targetUrl, init);
  if (!upstream) {
    return jsonResponse(req, { ok: false, error: "Upstream fetch failed or timed out" }, 502);
  }

  // build outgoing headers; include CORS headers matching incoming origin
  const outHeaders = new Headers(makeCorsHeaders(req));
  // Copy/transform upstream headers
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk === "set-cookie") {
      // rewrite and append each Set-Cookie value (ensure host-only)
      // Note: upstream.headers.forEach will call for each header value already.
      const rewritten = rewriteSetCookieForOurDomain(v);
      outHeaders.append("set-cookie", rewritten);
    } else if (lk === "location") {
      // rewrite absolute Location pointing to TARGET_HOST to relative path so client stays under our domain
      try {
        const locUrl = new URL(v, TARGET_HOST);
        if (locUrl.origin === (new URL(TARGET_HOST)).origin) {
          const rel = locUrl.pathname + locUrl.search + locUrl.hash;
          outHeaders.set("location", rel);
        } else {
          outHeaders.set(k, v);
        }
      } catch (_) {
        outHeaders.set(k, v);
      }
    } else if (lk === "content-type") {
      outHeaders.set("content-type", v);
    } else {
      // append other headers (preserve multiple values)
      outHeaders.append(k, v);
    }
  });

  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    const text = await upstream.text();
    // rewrite absolute references to TARGET_HOST -> relative (basic approach)
    const escaped = TARGET_HOST.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    const re1 = new RegExp(escaped, "g");
    let final = text.replace(re1, "");
    // also replace origin occurrences
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
    return new Response(buf, { status: upstream.status, headers: outHeaders });
  }
}

async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const pathname = url.pathname || "/";

    // Preflight
    if (req.method === "OPTIONS") {
      return corsPreflightResponse(req);
    }

    // Health
    if (req.method === "GET" && pathname === "/health") {
      return jsonResponse(req, { ok: true, now: new Date().toISOString() }, 200);
    }

    // Serve UI at /app
    if (req.method === "GET" && pathname === "/app") {
      return textResponse(req, getHTML(), 200);
    }

    // Login: proxy to target login and forward Set-Cookie headers (rewritten) to client
    if (req.method === "POST" && pathname === "/login") {
      try {
        const body = await req.json();
        const upstream = await timeoutFetch(`${TARGET_HOST}/secure/auth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Source": "WEB",
            "Referrer": `${TARGET_HOST}/secure/auth/login`
          },
          body: JSON.stringify({ username: body.username, password: body.password }),
          redirect: "manual"
        }, DEFAULT_FETCH_TIMEOUT);

        if (!upstream) return jsonResponse(req, { ok: false, error: "Upstream timeout" }, 504);

        // Build response headers with CORS + forwarded Set-Cookie(s)
        const resHeaders = new Headers(makeCorsHeaders(req));
        upstream.headers.forEach((v, k) => {
          if (k.toLowerCase() === "set-cookie") {
            resHeaders.append("set-cookie", rewriteSetCookieForOurDomain(v));
          } else if (k.toLowerCase() === "location") {
            // rewrite location if needed
            try {
              const locUrl = new URL(v, TARGET_HOST);
              if (locUrl.origin === (new URL(TARGET_HOST)).origin) {
                const rel = locUrl.pathname + locUrl.search + locUrl.hash;
                resHeaders.set("location", rel);
              } else {
                resHeaders.set("location", v);
              }
            } catch (_) {
              resHeaders.set("location", v);
            }
          } else if (k.toLowerCase() === "content-type") {
            resHeaders.set("content-type", v);
          }
        });

        const text = await upstream.text().catch(()=>"");
        const bodyObj = {
          ok: upstream.ok,
          upstreamStatus: upstream.status,
          message: text || ""
        };

        return new Response(JSON.stringify(bodyObj), { status: 200, headers: resHeaders });
      } catch (err) {
        const msg = (err instanceof Error && err.name === "AbortError") ? "Upstream timed out" : (err instanceof Error ? err.message : String(err));
        return jsonResponse(req, { ok: false, error: msg }, 500);
      }
    }

    // Add appointment: forward cookies from browser (they will be sent automatically if credentials: 'include')
    if (req.method === "POST" && pathname === "/rs/add") {
      try {
        const body = await req.json();
        const cookieHeader = req.headers.get("cookie") || "";

        const upstream = await timeoutFetch(`${TARGET_HOST}/rs/add`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Source": "WEB",
            "Alt-Used": "ecsc-expat.sy:8443",
            "Sec-Fetch-Site": "same-site",
            ...(cookieHeader ? { "Cookie": cookieHeader } : {})
          },
          body: JSON.stringify({
            missionId: parseInt(body.missionId || body.city || 0, 10),
            serviceId: parseInt(body.serviceId || body.service || 113, 10),
            copies: parseInt(body.copies || 1, 10),
            date: body.date === "" ? null : (body.date || null)
          }),
          redirect: "manual"
        }, DEFAULT_FETCH_TIMEOUT);

        if (!upstream) return jsonResponse(req, { ok: false, error: "Upstream timeout" }, 504);

        // Forward any Set-Cookie headers from upstream so browser stores them under our domain
        const resHeaders = new Headers(makeCorsHeaders(req));
        upstream.headers.forEach((v, k) => {
          if (k.toLowerCase() === "set-cookie") {
            resHeaders.append("set-cookie", rewriteSetCookieForOurDomain(v));
          }
        });

        const len = parseInt(upstream.headers.get("content-length") || "0", 10);
        let message = "";
        if (upstream.status === 400 && len === 220) message = "تم حجز كافة المواعيد المخصصة لهذه الخدمة.. يرجى اختيار يوم آخر";
        else if (upstream.status === 400 && len === 165) message = "حظ أوفر لم يتوفر هذا اليوم بعد حاول مرة أخرى";
        else if (upstream.status === 403) message = "انتهت صلاحية الجلسة";
        else if (upstream.status === 400 && [225, 189, 186].includes(len)) message = "لديك حجز مسبق";
        else if (upstream.status === 200) message = "تم التثبيت بنجاح";
        else message = "استجابة غير متوقعة من الخادم";

        const bodyObj = {
          ok: upstream.ok,
          upstreamStatus: upstream.status,
          message
        };

        return new Response(JSON.stringify(bodyObj), { status: 200, headers: resHeaders });
      } catch (err) {
        const msg = (err instanceof Error && err.name === "AbortError") ? "Upstream timed out" : (err instanceof Error ? err.message : String(err));
        return jsonResponse(req, { ok: false, error: msg }, 500);
      }
    }

    // fallback: proxy everything else to TARGET_HOST (this includes GET / which will show captcha under your domain)
    const targetUrl = TARGET_HOST.replace(/\/+$/, "") + pathname + url.search;
    return await proxyToTarget(req, targetUrl);

  } catch (err) {
    return jsonResponse(req, { ok: false, error: (err instanceof Error ? err.message : String(err)) }, 500);
  }
}

// Start server (Deno.serve); Deno Deploy will bind automatically
const port = Number(Deno.env.get("PORT") || 8000);
console.log(`Starting server (Deno) — port ${port} — TARGET_HOST=${TARGET_HOST}`);
Deno.serve({ port }, handler);

// ---------------------- client HTML (runs in browser) ----------------------
// Note: client fetches now use credentials: 'include' so cookies are stored and sent automatically.
function getHTML(): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Jumaa — نظام الحجوزات</title>
<style>
  :root{--bg:#f4f7fb;--card:#fff;--accent:#0753a6;--accent2:#2ea6ff}
  *{box-sizing:border-box} body{margin:0;font-family:Inter,Arial;direction:rtl;background:var(--bg)}
  .page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px}
  .card{width:520px;max-width:95vw;background:var(--card);border-radius:14px;padding:22px;box-shadow:0 20px 50px rgba(20,30,60,0.12)}
  h1{margin:0 0 6px;color:var(--accent);text-align:center;font-size:22px} .sub{font-size:12px;color:#667;text-align:center;margin-bottom:14px}
  label{display:block;margin-top:10px;font-weight:600;font-size:13px}
  input,select{width:100%;padding:10px;border-radius:10px;border:1px solid #e6eef7;margin-top:6px;background:#fbfdff}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .btn{padding:10px 14px;border-radius:10px;border:none;cursor:pointer;font-weight:700}
  .btn-primary{background:linear-gradient(90deg,var(--accent),var(--accent2));color:#fff}
  .btn-ghost{background:transparent;border:1px solid #e6eef7;color:var(--accent);padding:9px 12px;border-radius:10px}
  #messages{margin-top:14px;height:140px;overflow:auto;padding:10px;border-radius:10px;background:#fbfdff;border:1px solid #eef5ff}
  .msg{padding:10px;border-radius:10px;margin-bottom:8px;color:#fff}
  .msg.ok{background:linear-gradient(90deg,#2e7d32,#66bb6a)} .msg.err{background:linear-gradient(90deg,#c62828,#ff6f61)}
</style>
</head>
<body>
<div class="page">
  <div class="card" role="main" aria-live="polite">
    <h1>Jumaa</h1>
    <div class="sub">الشركة السورية للسلملي</div>

    <label>البريد الإلكتروني</label>
    <input id="username" type="text" placeholder="example@domain.com">

    <label>كلمة المرور</label>
    <input id="password" type="password" placeholder="••••••••">

    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
      <button id="loginBtn" class="btn btn-primary">تسجيل الدخول</button>
      <button id="clearCookies" class="btn btn-ghost">مسح الكوكيز</button>
      <div style="flex:1"></div>
      <div id="status" class="status"></div>
    </div>

    <hr style="margin:14px 0;border:none;border-top:1px solid #eef6ff">

    <div class="two">
      <div>
        <label>التاريخ</label>
        <input id="date" type="date">
      </div>
      <div>
        <label>المدينة</label>
        <select id="city">
          <option value="">— اختر —</option>
          <option value="17">برلين</option>
          <option value="5">بروكسل</option>
          <option value="6">اسطنبول</option>
          <option value="7">دبي</option>
          <option value="21">الرياض</option>
          <option value="9">بيروت</option>
          <option value="999000060">الدوحة</option>
        </select>
      </div>
    </div>

    <div class="two">
      <div>
        <label>نوع الخدمة</label>
        <select id="service">
          <option value="113">عادي</option>
          <option value="102">مستعجل</option>
        </select>
      </div>
      <div>
        <label>عدد النسخ</label>
        <input id="copies" type="number" min="1" value="1">
      </div>
    </div>

    <label>الفاصل (مللي ثانية)</label>
    <input id="interval" type="number" min="250" value="1000">

    <div style="margin-top:14px;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap">
      <button id="startBtn" class="btn btn-primary">بدء التثبيت التلقائي</button>
      <div style="display:flex;align-items:center;gap:10px">
        <button id="sendOnce" class="btn btn-ghost">إرسال مرة واحدة</button>
      </div>
    </div>

    <div id="messages" aria-live="polite" aria-atomic="false"></div>
    <div class="footer" style="font-size:12px;color:#667;text-align:center;margin-top:12px">جميع الحقوق محفوظة 2025</div>
  </div>
</div>

<script>
(function() {
  const loginBtn = document.getElementById('loginBtn');
  const clearBtn = document.getElementById('clearCookies');
  const startBtn = document.getElementById('startBtn');
  const sendOnceBtn = document.getElementById('sendOnce');
  const messages = document.getElementById('messages');

  let autoTimer = null;
  let pending = 0;

  function addMessage(text, ok = false, duration = 3000) {
    const d = document.createElement('div');
    d.className = 'msg ' + (ok ? 'ok' : 'err');
    d.textContent = text;
    messages.prepend(d);
    setTimeout(() => { try { d.remove(); } catch(_){} }, duration);
  }

  clearBtn.addEventListener('click', () => {
    // delete cookies for this domain (best-effort)
    document.cookie.split(";").forEach(c => {
      const name = c.split("=")[0].trim();
      document.cookie = name + "=; Max-Age=0; path=/";
    });
    addMessage('تم مسح الكوكيز محليًا', false, 1800);
  });

  // LOGIN: use credentials: 'include' so Set-Cookie sent by server is stored by browser
  loginBtn.addEventListener('click', async () => {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    if (!username || !password) { addMessage('الرجاء إدخال البريد وكلمة المرور', false); return; }

    try {
      pending++; showSpinner(true);
      const res = await fetch('/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok) {
        addMessage(data.message || 'تم تسجيل الدخول', true);
      } else {
        addMessage(data.error || data.message || 'فشل تسجيل الدخول', false);
      }
    } catch (err) {
      addMessage('فشل تسجيل الدخول', false);
    } finally {
      pending = Math.max(0, pending-1);
      if (pending === 0) showSpinner(false);
    }
  });

  async function sendInstallOnce() {
    const date = document.getElementById('date').value || null;
    const missionId = parseInt(document.getElementById('city').value || '0', 10);
    const serviceId = parseInt(document.getElementById('service').value || '113', 10);
    const copies = parseInt(document.getElementById('copies').value || '1', 10);

    if (!missionId) { addMessage('اختر مدينة صحيحة', false); return; }

    try {
      pending++; showSpinner(true);
      const resp = await fetch('/rs/add', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missionId, serviceId, copies, date })
      });
      const data = await resp.json();
      const isOk = (typeof data.upstreamStatus !== 'undefined' ? (data.upstreamStatus === 200) : (data.ok === true));
      addMessage(data.message || 'تم الإرسال', isOk);
    } catch (err) {
      addMessage('فشل الاتصال بالخادم', false);
    } finally {
      pending = Math.max(0, pending-1);
      if (pending === 0) showSpinner(false);
    }
  }

  function showSpinner(flag) {
    const status = document.getElementById('status');
    status.innerHTML = flag ? '<span style="display:inline-block;width:18px;height:18px;border-radius:50%;border:3px solid rgba(0,0,0,0.08);border-top:3px solid var(--accent);animation:spin 1s linear infinite"></span>' : '';
  }

  startBtn.addEventListener('click', () => {
    if (autoTimer) {
      clearInterval(autoTimer); autoTimer = null;
      startBtn.textContent = 'بدء التثبيت التلقائي';
      addMessage('تم إيقاف التثبيت التلقائي', false);
      return;
    }
    const interval = Math.max(250, parseInt(document.getElementById('interval').value || '1000', 10));
    autoTimer = setInterval(sendInstallOnce, interval);
    startBtn.textContent = 'إيقاف التثبيت';
    addMessage('تم تشغيل التثبيت التلقائي كل ' + interval + ' مللي ثانية', true);
  });

  sendOnceBtn.addEventListener('click', sendInstallOnce);

})();
</script>
</body>
</html>`;
}
