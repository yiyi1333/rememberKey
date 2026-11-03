import { describe, expect, it, vi } from 'vitest';
import { proxyRequest, type PagesEnv } from './proxy';

const origin = 'https://keys.example.com';
function environment(fetch: ReturnType<typeof vi.fn>): PagesEnv {
  return { API: { fetch } as unknown as Fetcher, RK_ORIGIN: origin };
}

describe('Pages service-binding proxy', () => {
  it('preserves URL, query, method, headers and a streaming body consumed once', async () => {
    let pulls = 0;
    const body = new ReadableStream({ start(controller) {
      pulls++;
      controller.enqueue(new TextEncoder().encode('{"opaque":"payload"}'));
      controller.close();
    } });
    const fetch = vi.fn(async (forwarded: Request) => {
      expect(forwarded.url).toBe(`${origin}/api/v1/sync?cursor=3&tag=a%2Fb`);
      expect(forwarded.method).toBe('POST');
      expect(forwarded.redirect).toBe('manual');
      expect(forwarded.headers.get('authorization')).toBe('Bearer opaque');
      expect(forwarded.headers.get('origin')).toBe(origin);
      expect(forwarded.headers.get('cookie')).toBe('rk_refresh=old');
      expect(await forwarded.text()).toBe('{"opaque":"payload"}');
      return new Response('ok', { headers: { 'Cache-Control': 'no-store' } });
    });
    const request = new Request(`${origin}/api/v1/sync?cursor=3&tag=a%2Fb`, {
      method: 'POST', body, duplex: 'half',
      headers: { Authorization: 'Bearer opaque', Origin: origin, Cookie: 'rk_refresh=old' },
    } as RequestInit);
    expect(await (await proxyRequest(request, environment(fetch))).text()).toBe('ok');
    expect(pulls).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('returns the original response and host-only refresh cookie untouched', async () => {
    const cookie = 'rk_refresh=rotated; Path=/api/v1/auth; Secure; HttpOnly; SameSite=Strict';
    const upstream = new Response(null, { status: 204, headers: {
      'Set-Cookie': cookie, 'Cache-Control': 'no-store',
    } });
    const fetch = vi.fn(async () => upstream);
    const response = await proxyRequest(new Request(`${origin}/api/v1/auth/refresh`, {
      method: 'POST', headers: { Origin: origin, Cookie: 'rk_refresh=old' },
    }), environment(fetch));
    expect(response).toBe(upstream);
    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toBe(cookie);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each(['https://other.example.com', 'https://hash.keys.pages.dev', 'http://keys.example.com'])
  ('rejects request URL origin %s before invoking the binding', async (urlOrigin) => {
    const fetch = vi.fn();
    const response = await proxyRequest(new Request(`${urlOrigin}/healthz`, {
      headers: { Origin: origin, 'X-Forwarded-Host': 'keys.example.com' },
    }), environment(fetch));
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not manufacture or replace the browser Origin header', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get('origin')).toBe('https://untrusted.example');
      return new Response(null, { status: 403 });
    });
    await proxyRequest(new Request(`${origin}/api`, {
      method: 'POST', headers: { Origin: 'https://untrusted.example' },
    }), environment(fetch));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('preserves API JSON 404 and redirect responses instead of SPA fallback or following', async () => {
    for (const upstream of [
      new Response('{"error":{"code":"not_found"}}', { status: 404 }),
      new Response(null, { status: 302, headers: { Location: '/api/v1/elsewhere' } }),
    ]) {
      const response = await proxyRequest(new Request(`${origin}/api/unknown`), environment(vi.fn(async () => upstream)));
      expect(response).toBe(upstream);
    }
  });

  it('returns a controlled no-store 503 when the service binding fails', async () => {
    const response = await proxyRequest(new Request(`${origin}/readyz`), environment(vi.fn(async () => {
      throw new Error('private upstream details');
    })));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await response.json()).toEqual({ error: { code: 'upstream_unavailable', message: 'upstream unavailable' } });
  });
});
