/**
 * rememberKey Cloudflare Worker entry point.
 *
 * Routes:
 *   GET  /healthz            liveness
 *   GET  /readyz             D1 reachability
 *   *    /api/v1/...         JSON API (see PROTOCOL.md)
 *   *    everything else     JSON 404 (static files are served by Pages)
 */

import { adminRoutes } from './admin';
import { authenticate, authProtectedRoutes, authPublicRoutes } from './auth';
import { errorResponse, fail, HttpError, originProblem } from './http';
import { syncRoutes } from './sync';
import type { Env, RouteContext } from './types';

const API_PREFIX = '/api/v1';
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const RATE_MAP_LIMIT = 10_000;
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
/** API and health responses must never be cached (matches the Go server). */
const API_SECURITY_HEADERS: Record<string, string> = {
  ...SECURITY_HEADERS,
  'Cache-Control': 'no-store',
};

interface Bucket {
  start: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

function clientKey(request: Request, path: string): string {
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  return `${ip}:${path}`;
}

function pruneBuckets(nowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.start > RATE_WINDOW_MS) buckets.delete(key);
  }
}

function limitedPath(pathname: string, method: string): boolean {
  return (
    pathname.startsWith(`${API_PREFIX}/auth/`) ||
    pathname === `${API_PREFIX}/accounts/lookup` ||
    pathname === `${API_PREFIX}/registrations` ||
    (pathname === `${API_PREFIX}/devices` && method === 'POST')
  );
}

/** Best-effort per-isolate rate limiting (Cloudflare WAF covers the hard guarantee). */
function rateLimited(request: Request, pathname: string, method: string): boolean {
  if (!limitedPath(pathname, method)) return false;
  const nowMs = Date.now();
  const key = clientKey(request, pathname);
  const existing = buckets.get(key);
  if (existing === undefined) {
    if (buckets.size >= RATE_MAP_LIMIT) {
      pruneBuckets(nowMs);
      if (buckets.size >= RATE_MAP_LIMIT) return true;
    }
    buckets.set(key, { start: nowMs, count: 1 });
    return false;
  }
  if (nowMs - existing.start > RATE_WINDOW_MS) {
    buckets.set(key, { start: nowMs, count: 1 });
    return false;
  }
  existing.count += 1;
  return existing.count > RATE_LIMIT;
}

function withSecurityHeaders(
  response: Response,
  headersToSet: Record<string, string> = SECURITY_HEADERS,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(headersToSet)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

let checkedOrigin: string | null = null;
let originError: string | null = null;

/** Validate RK_ORIGIN once per isolate; a misconfigured deployment fails closed. */
function configProblem(env: Env): string | null {
  if (env.RK_ORIGIN === checkedOrigin) return originError;
  checkedOrigin = env.RK_ORIGIN;
  originError =
    typeof env.RK_ORIGIN === 'string' ? originProblem(env.RK_ORIGIN) : 'RK_ORIGIN is required';
  if (originError !== null) {
    console.error(`invalid RK_ORIGIN ${String(env.RK_ORIGIN)}: ${originError}`);
  }
  return originError;
}

/** Path relative to /api/v1; non-API paths are not passed to route modules. */
function apiPath(pathname: string): string {
  if (pathname === API_PREFIX) return '';
  return pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length) : pathname;
}

/** Match existing protected handlers before authentication, so unknown URLs are 404. */
function protectedRoute(path: string, method: string): boolean {
  switch (method) {
    case 'GET':
      return [
        '/me', '/devices', '/sync/changes', '/sync/snapshot', '/admin/users', '/admin/audit',
      ].includes(path);
    case 'POST':
      return path === '/sync/operations' || path === '/admin/invitations';
    case 'DELETE':
      return path === '/auth/sessions' || path.startsWith('/devices/');
    case 'PUT':
      return path === '/key-bundle';
    case 'PATCH':
      return /^\/admin\/users\/[^/]+$/.test(path);
    default:
      return false;
  }
}

async function route(ctx: RouteContext): Promise<Response> {
  const publicResponse = await authPublicRoutes(ctx);
  if (publicResponse !== null) return publicResponse;

  if (!protectedRoute(ctx.path, ctx.method)) throw fail(404, 'not_found');

  const identity = await authenticate(ctx);

  const protectedResponse =
    (await authProtectedRoutes(ctx, identity)) ??
    (await syncRoutes(ctx, identity)) ??
    (await adminRoutes(ctx, identity));
  if (protectedResponse !== null) return protectedResponse;

  throw fail(404, 'not_found');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (pathname === '/healthz') {
      return withSecurityHeaders(new Response('ok', { status: 200 }), API_SECURITY_HEADERS);
    }
    if (pathname === '/readyz') {
      try {
        await env.DB.prepare('SELECT 1').first();
        return withSecurityHeaders(new Response('ready', { status: 200 }), API_SECURITY_HEADERS);
      } catch {
        return withSecurityHeaders(new Response('unavailable', { status: 503 }), API_SECURITY_HEADERS);
      }
    }

    if (configProblem(env) !== null) {
      return withSecurityHeaders(errorResponse(new HttpError(500, 'internal_error')), API_SECURITY_HEADERS);
    }

    // Preserve Origin checking for every non-GET/HEAD request handled by this
    // Worker, including unknown paths. Pages handles its own static requests.
    if (method !== 'GET' && method !== 'HEAD' && request.headers.get('origin') !== env.RK_ORIGIN) {
      return withSecurityHeaders(
        errorResponse(new HttpError(403, 'origin_rejected')),
        API_SECURITY_HEADERS,
      );
    }

    if (!pathname.startsWith('/api/')) {
      return withSecurityHeaders(errorResponse(new HttpError(404, 'not_found')), API_SECURITY_HEADERS);
    }

    try {
      if (rateLimited(request, pathname, method)) {
        throw fail(429, 'rate_limited');
      }

      const ctx: RouteContext = {
        env,
        request,
        url,
        path: apiPath(pathname),
        method,
      };
      return withSecurityHeaders(await route(ctx), API_SECURITY_HEADERS);
    } catch (error) {
      if (error instanceof HttpError) {
        const headers: Record<string, string> =
          error.code === 'rate_limited' ? { 'Retry-After': '60' } : {};
        return withSecurityHeaders(errorResponse(error, headers), API_SECURITY_HEADERS);
      }
      console.error('request failed:', method, pathname, error);
      return withSecurityHeaders(errorResponse(error), API_SECURITY_HEADERS);
    }
  },
} satisfies ExportedHandler<Env>;
