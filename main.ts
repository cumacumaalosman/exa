const TARGET_HOST = 'https://bold-credit-0176.cumaalosman.workers.dev/'

Deno.serve(async (request: Request): Promise<Response> => {
  const origUrl = new URL(request.url)
  const targetUrl = new URL(TARGET_HOST)
  targetUrl.pathname = origUrl.pathname
  targetUrl.search = origUrl.search

  const headers = new Headers(request.headers)
  headers.set('Host', targetUrl.hostname)
  headers.set('Origin', `https://${targetUrl.hostname}`)
  headers.set('Referer', `https://${targetUrl.hostname}${origUrl.pathname}`)

  // تمرير البودي إذا موجود
  let requestBody = null
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    requestBody = await request.clone().arrayBuffer()
  }

  try {
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body: requestBody,
      redirect: 'manual'
    })

    // 🟢 هون بنرجع الرد الأصلي كما هو بدون أي تعديل
    const respBody = await response.arrayBuffer()
    const newHeaders = new Headers(response.headers)

    // السماح بالعرض بالمتصفح
    newHeaders.set('Access-Control-Allow-Origin', '*')
    newHeaders.set('Access-Control-Allow-Credentials', 'true')

    return new Response(respBody, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    })
  } catch (err) {
    return new Response('Bad gateway: ' + err.toString(), { status: 502 })
  }
})
