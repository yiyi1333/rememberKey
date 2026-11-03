import { describe, expect, it, vi } from 'vitest';

import handler from '../src/index';
import type { Env } from '../src/types';

const ORIGIN = 'https://keys.example.com';

function environment(db: Partial<D1Database> = {}): Env {
  return { DB: db as D1Database, RK_ORIGIN: ORIGIN } as Env;
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await response.json()).toEqual({ error: { code, message: code.replaceAll('_', ' ') } });
}

describe('API-only Worker entry', () => {
  it.each(['/assets/missing.js', '/', '/api'])('returns JSON 404 for %s without an asset binding', async (path) => {
    const response = await handler.fetch(new Request(`${ORIGIN}${path}`), environment());
    await expectError(response, 404, 'not_found');
  });

  it('keeps liveness independent of database and origin configuration', async () => {
    const response = await handler.fetch(new Request(`${ORIGIN}/healthz`), {
      DB: {} as D1Database,
      RK_ORIGIN: '',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('ok');
  });

  it('reports readiness when D1 responds', async () => {
    const first = vi.fn().mockResolvedValue({ '1': 1 });
    const prepare = vi.fn().mockReturnValue({ first });
    const response = await handler.fetch(new Request(`${ORIGIN}/readyz`), environment({ prepare }));
    expect(prepare).toHaveBeenCalledWith('SELECT 1');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('ready');
  });

  it('reports unavailable readiness when D1 fails', async () => {
    const prepare = vi.fn().mockReturnValue({ first: vi.fn().mockRejectedValue(new Error('D1 unavailable')) });
    const response = await handler.fetch(new Request(`${ORIGIN}/readyz`), environment({ prepare }));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('unavailable');
  });

  it.each(['/api/v1/registrations', '/assets/missing.js'])('rejects writes from the wrong Origin at %s', async (path) => {
    const response = await handler.fetch(new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { origin: 'https://other.example.com' },
    }), environment());
    await expectError(response, 403, 'origin_rejected');
  });

  it.each(['/api/v1/missing', '/api/v1/admin/missing', '/api/v2/me'])('returns JSON 404 for unknown API path %s before authentication', async (path) => {
    const response = await handler.fetch(new Request(`${ORIGIN}${path}`), environment());
    await expectError(response, 404, 'not_found');
  });

  it.each([
    ['GET', '/me'],
    ['GET', '/devices'],
    ['DELETE', '/devices/device-id'],
    ['PUT', '/key-bundle'],
    ['DELETE', '/auth/sessions'],
    ['POST', '/sync/operations'],
    ['GET', '/sync/changes'],
    ['GET', '/sync/snapshot'],
    ['GET', '/admin/users'],
    ['PATCH', '/admin/users/account-id'],
    ['POST', '/admin/invitations'],
    ['GET', '/admin/audit'],
  ])('preserves authentication errors for %s %s', async (method, path) => {
    const response = await handler.fetch(new Request(`${ORIGIN}/api/v1${path}`, {
      method,
      headers: { origin: ORIGIN },
    }), environment());
    await expectError(response, 401, 'unauthorized');
  });
});
