export interface PagesEnv {
  API: Fetcher;
  RK_ORIGIN: string;
}

function failure(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: code.replaceAll('_', ' ') } }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/** Keep the public URL and browser headers intact for the API's security checks. */
export async function proxyRequest(request: Request, env: PagesEnv): Promise<Response> {
  if (new URL(request.url).origin !== env.RK_ORIGIN) return failure(403, 'origin_rejected');
  try {
    return await env.API.fetch(new Request(request, { redirect: 'manual' }));
  } catch {
    return failure(503, 'upstream_unavailable');
  }
}
