// server.ts — جاهز للنشر على Deno Deploy
const TARGET_HOST = "https://ecsc-expat.sy:8443";
const DEFAULT_FETCH_TIMEOUT = 8000; // ms

function jsonResponse(obj: unknown, status = 200, extraHeaders?: Record<string,string>) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders
  });
  return new Response(JSON.stringify(obj), { status, headers });
}

function textResponse(text: string, status = 200, extraHeaders?: Record<string,string>) {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders
  });
  return new Response(text, { status, headers });
}

function corsPreflightResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Source, Cookie"
    }
  });
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

async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const pathname = url.pathname || "/";

    // health / warmup endpoint (fast response for deploy warm-up)
    if (req.method === "GET" && pathname === "/health") {
      return jsonResponse({ ok: true, now: new Date().toISOString() }, 200);
    }

    // Serve UI
    if (req.method === "GET" && (pathname === "/" || pathname === "")) {
      return textResponse(getHTML(), 200, { "Content-Type": "text/html; charset=utf-8" });
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      return corsPreflightResponse();
    }

    // Login proxy: returns cookies string in JSON
    if (req.method === "POST" && pathname === "/login") {
      try {
        const body = await req.json();
        const resp = await timeoutFetch(`${TARGET_HOST}/secure/auth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Source": "WEB",
            "Referrer": `${TARGET_HOST}/secure/auth/login`
          },
          body: JSON.stringify({ username: body.username, password: body.password }),
          redirect: "manual"
        }, DEFAULT_FETCH_TIMEOUT);

        const setCookie = resp?.headers.get("set-cookie") || "";
        const text = await resp.text().catch(()=>"");

        return jsonResponse({
          ok: resp?.ok ?? false,
          upstreamStatus: resp?.status ?? 0,
          cookies: setCookie,
          message: typeof text === "string" ? text : ""
        });
      } catch (err) {
        const msg = (err instanceof Error && err.name === "AbortError")
          ? "Upstream request timed out"
          : err instanceof Error ? err.message : String(err);
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // Add appointment proxy: forwards browser cookies to target
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

        const len = parseInt(upstream.headers.get("content-length") || "0", 10);
        let message = "";
        if (upstream.status === 400 && len === 220) message = "تم حجز كافة المواعيد المخصصة لهذه الخدمة.. يرجى اختيار يوم آخر";
        else if (upstream.status === 400 && len === 165) message = "حظ أوفر لم يتوفر هذا اليوم بعد حاول مرة أخرى";
        else if (upstream.status === 403) message = "انتهت صلاحية الجلسة";
        else if (upstream.status === 400 && [225, 189, 186].includes(len)) message = "لديك حجز مسبق";
        else if (upstream.status === 200) message = "تم التثبيت بنجاح";
        else message = "استجابة غير متوقعة من الخادم";

        return jsonResponse({
          ok: upstream.ok,
          upstreamStatus: upstream.status,
          message
        });
      } catch (err) {
        const msg = (err instanceof Error && err.name === "AbortError")
          ? "Upstream request timed out"
          : err instanceof Error ? err.message : String(err);
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // unknown
    return jsonResponse({ error: "مسار غير معروف" }, 404);
  } catch (err) {
    return jsonResponse({ ok: false, error: (err instanceof Error ? err.message : String(err)) }, 500);
  }
}

// Start server using Deno.serve — Deno Deploy ignores port param and binds automatically.
const port = Number(Deno.env.get("PORT") || 8000);
console.log(`Starting server (Deno) — port ${port} — TARGET_HOST=${TARGET_HOST}`);
Deno.serve({ port }, handler);

// ---------------------- client HTML (runs in browser) ----------------------
function getHTML(): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Jumaa — نظام الحجوزات</title>
<style>
  :root{
    --bg:#f4f7fb; --card:#ffffff; --accent:#0753a6; --accent2:#2ea6ff; --ok:#2e7d32; --err:#c62828;
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:Inter, "Segoe UI", Tahoma, Arial; background:var(--bg); color:#111; direction:rtl}
  .page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px}
  .card{width:520px;max-width:95vw;background:var(--card);border-radius:14px;padding:22px;box-shadow:0 20px 50px rgba(20,30,60,0.12)}
  h1{margin:0 0 6px;color:var(--accent);text-align:center;font-size:22px}
  .sub{font-size:12px;color:#667;text-align:center;margin-bottom:14px}
  label{display:block;margin-top:10px;font-weight:600;font-size:13px}
  input[type="text"], input[type="password"], input[type="date"], input[type="number"], select{
    width:100%;padding:10px;border-radius:10px;border:1px solid #e6eef7;margin-top:6px;font-size:14px;background:#fbfdff;
  }
  .row{display:flex;gap:12px;align-items:center}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .btn{display:inline-block;padding:10px 14px;border-radius:10px;border:none;cursor:pointer;font-weight:700}
  .btn-primary{background:linear-gradient(90deg,var(--accent),var(--accent2));color:#fff}
  .btn-ghost{background:transparent;border:1px solid #e6eef7;color:var(--accent);border-radius:10px;padding:9px 12px}
  .controls{margin-top:14px;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
  #messages{margin-top:14px;height:140px;overflow:auto;padding-right:6px;border-radius:10px;background:#fbfdff;border:1px solid #eef5ff;padding:10px}
  .msg{padding:10px 12px;border-radius:10px;margin-bottom:8px;color:#fff;box-shadow:0 8px 20px rgba(10,20,40,0.06);opacity:0;transform:translateY(12px);transition:all .36s cubic-bezier(.2,.9,.2,1)}
  .msg.show{transform:translateY(0);opacity:1}
  .msg.ok{background:linear-gradient(90deg,#2e7d32,#66bb6a)}
  .msg.err{background:linear-gradient(90deg,#c62828,#ff6f61)}
  .status{font-size:13px;color:#444}
  .footer{font-size:12px;color:#667;text-align:center;margin-top:12px}
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  @media (max-width: 600px) {
    .two{grid-template-columns:1fr}
    .card{padding:16px}
  }
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

    <div class="controls">
      <button id="startBtn" class="btn btn-primary">بدء التثبيت التلقائي</button>
      <div style="display:flex;align-items:center;gap:10px">
        <button id="sendOnce" class="btn btn-ghost">إرسال مرة واحدة</button>
      </div>
    </div>

    <div id="messages" aria-live="polite" aria-atomic="false"></div>
    <div class="footer">جميع الحقوق محفوظة 2025</div>
  </div>
</div>

<script>
(function() {
  const loginBtn = document.getElementById('loginBtn');
  const clearBtn = document.getElementById('clearCookies');
  const startBtn = document.getElementById('startBtn');
  const sendOnceBtn = document.getElementById('sendOnce');
  const messages = document.getElementById('messages');
  const status = document.getElementById('status');

  let autoTimer = null;
  let pending = 0;

  function addMessage(text, ok = false, duration = 3000) {
    const d = document.createElement('div');
    d.className = 'msg ' + (ok ? 'ok' : 'err');
    d.textContent = text;
    messages.prepend(d);
    // animate in
    requestAnimationFrame(() => d.classList.add('show'));
    // disappear after duration
    setTimeout(() => {
      d.classList.remove('show');
      setTimeout(() => { try { d.remove(); } catch(_){} }, 420);
    }, duration);
  }

  function showSpinner(flag) {
    status.innerHTML = flag ? '<span style="display:inline-block;width:18px;height:18px;border-radius:50%;border:3px solid rgba(0,0,0,0.08);border-top:3px solid var(--accent);animation:spin 1s linear infinite"></span>' : '';
  }

  // Clear document cookies for current origin (simple approach)
  clearBtn.addEventListener('click', () => {
    const cookies = document.cookie.split(";").map(c => c.trim()).filter(Boolean);
    cookies.forEach(c => {
      const name = c.split('=')[0];
      document.cookie = name + "=; Max-Age=0; path=/";
    });
    addMessage('تم مسح الكوكيز محليًا', false, 1800);
  });

  // Login: call worker /login, extract Set-Cookie string and set document.cookie
  loginBtn.addEventListener('click', async () => {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    if (!username || !password) { addMessage('الرجاء إدخال البريد وكلمة المرور', false, 2200); return; }

    try {
      pending++; showSpinner(true);
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      const cookies = data.cookies || data.cookie || '';
      if (cookies) {
        // split on newline or comma, keep tokens that contain '='
        const parts = cookies.split(/\\r?\\n|,\\s*/).filter(Boolean);
        parts.forEach(p => {
          try {
            const nv = p.split(';')[0].trim();
            if (nv && nv.includes('=')) {
              document.cookie = nv + '; path=/';
            }
          } catch(_) {}
        });
        addMessage('تم تسجيل الدخول وتثبيت الجلسة', true, 2200);
      } else {
        addMessage('تم تسجيل الدخول — لم يتم إرسال كوكيز من الخادم', false, 2200);
      }
    } catch (err) {
      addMessage('فشل تسجيل الدخول', false, 2200);
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

    if (!missionId) { addMessage('اختر مدينة صحيحة', false, 2000); return; }

    try {
      pending++; showSpinner(true);
      const resp = await fetch('/rs/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missionId, serviceId, copies, date })
      });
      const data = await resp.json();
      // color by upstreamStatus
      const isOk = (typeof data.upstreamStatus !== 'undefined' ? (data.upstreamStatus === 200) : (data.ok === true));
      addMessage(data.message || 'تم الإرسال', isOk, 2800);
    } catch (err) {
      addMessage('فشل الاتصال بالخادم', false, 2800);
    } finally {
      pending = Math.max(0, pending-1);
      if (pending === 0) showSpinner(false);
    }
  }

  // start/stop auto
  startBtn.addEventListener('click', () => {
    if (autoTimer) {
      clearInterval(autoTimer); autoTimer = null;
      startBtn.textContent = 'بدء التثبيت التلقائي';
      addMessage('تم إيقاف التثبيت التلقائي', false, 1800);
      return;
    }
    const interval = Math.max(250, parseInt(document.getElementById('interval').value || '1000', 10));
    autoTimer = setInterval(sendInstallOnce, interval);
    startBtn.textContent = 'إيقاف التثبيت';
    addMessage('تم تشغيل التثبيت التلقائي كل ' + interval + ' مللي ثانية', true, 2000);
  });

  // manual send once
  sendOnceBtn.addEventListener('click', sendInstallOnce);

})();
</script>
</body>
</html>`;
}
