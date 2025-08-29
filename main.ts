const TARGET = "https://ecsc-expat.sy:8443";

function corsPreflight(origin?: string) {
  const o = origin || "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": o,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "*"
    },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return corsPreflight(request.headers.get("Origin") ?? undefined);
    }

    const url = new URL(request.url);
    const targetUrl = TARGET + url.pathname + url.search;

    const resp = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body
    });

    return resp;
  }
};
