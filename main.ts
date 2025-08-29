addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});

const TARGET = "https://ecsc-expat.sy:8443";

async function handleRequest(req) {
  // إذا المستخدم فتح الدومين تبعك بالمتصفح
  if (new URL(req.url).pathname === "/") {
    // اعمل redirect لواجهة الموقع الأصلي (للتحقق من الكابتشا)
    return Response.redirect(TARGET, 302);
  }

  const url = new URL(req.url);
  const targetUrl = TARGET + url.pathname + url.search;

  // ننسخ الطلب الأصلي ونعدل الهيدرز
  const headers = new Headers(req.headers);
  headers.set("Origin", "https://ecsc-expat.sy");
  headers.set("Referer", "https://ecsc-expat.sy/");
  headers.set("Host", "ecsc-expat.sy:8443");

  // نعمل الفتش
  const response = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.method !== "GET" && req.method !== "HEAD" ? await req.text() : undefined,
    redirect: "manual"
  });

  // نعدل الريسبونس للهروب من مشاكل CORS
  const resHeaders = new Headers(response.headers);
  resHeaders.set("Access-Control-Allow-Origin", "https://ecsc-expat.sy");
  resHeaders.set("Access-Control-Allow-Credentials", "true");

  return new Response(response.body, {
    status: response.status,
    headers: resHeaders
  });
}
