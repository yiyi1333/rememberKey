import { describe, expect, it } from 'vitest';

import {
  HttpError,
  originProblem,
  pageParams,
  refreshCookie,
  rfc3339,
  strictObject,
} from '../src/http';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof HttpError) return error.code;
    throw error;
  }
  throw new Error('expected an HttpError');
}

describe('originProblem', () => {
  it('accepts exact https origins', () => {
    expect(originProblem('https://keys.example.com')).toBeNull();
    expect(originProblem('https://keys.example.com:8443')).toBeNull();
  });

  it('accepts http on loopback only', () => {
    expect(originProblem('http://127.0.0.1:8787')).toBeNull();
    expect(originProblem('http://localhost:5173')).toBeNull();
    expect(originProblem('http://[::1]:8787')).toBeNull();
    expect(originProblem('http://keys.example.com')).toMatch(/https/);
  });

  it('rejects non-exact origins', () => {
    expect(originProblem('https://keys.example.com/')).toMatch(/exact origin/);
    expect(originProblem('https://keys.example.com/app')).toMatch(/exact origin/);
    expect(originProblem('https://keys.example.com?x=1')).toMatch(/exact origin/);
    expect(originProblem('https://keys.example.com#frag')).toMatch(/exact origin/);
    expect(originProblem('https://user:pass@keys.example.com')).toMatch(/credentials/);
  });

  it('rejects non-http schemes and non-absolute values', () => {
    expect(originProblem('ftp://keys.example.com')).toMatch(/http/);
    expect(originProblem('keys.example.com')).toMatch(/absolute origin/);
    expect(originProblem('')).toMatch(/absolute origin/);
  });
});

describe('refreshCookie', () => {
  it('sets Secure only for https origins', () => {
    const secure = refreshCookie('t', 30, 'https://keys.example.com');
    expect(secure).toContain('Secure');
    expect(refreshCookie('t', 30, 'http://127.0.0.1:8787')).not.toContain('Secure');
  });

  it('always pins HttpOnly, SameSite=Strict and the refresh path', () => {
    const cookie = refreshCookie('t', 30, 'https://keys.example.com');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/v1/auth');
    expect(cookie).toContain('Max-Age=30');
  });
});

describe('rfc3339', () => {
  it('keeps second precision and UTC', () => {
    expect(rfc3339(new Date('2026-10-28T12:34:56.789Z'))).toBe('2026-10-28T12:34:56Z');
  });
});

describe('pageParams', () => {
  it('defaults to cursor 0 and limit 100', () => {
    expect(pageParams(new URL('https://x/api/v1/sync/changes'))).toEqual({ cursor: 0, limit: 100 });
  });

  it('parses valid values', () => {
    expect(pageParams(new URL('https://x/api/v1/sync/changes?cursor=12&limit=100'))).toEqual({
      cursor: 12,
      limit: 100,
    });
  });

  it('rejects invalid cursors and limits with the protocol codes', () => {
    expect(codeOf(() => pageParams(new URL('https://x/?cursor=-1')))).toBe('invalid_cursor');
    expect(codeOf(() => pageParams(new URL('https://x/?cursor=abc')))).toBe('invalid_cursor');
    // Go used strconv.ParseInt: only plain decimal digits are accepted.
    expect(codeOf(() => pageParams(new URL('https://x/?cursor=0x10')))).toBe('invalid_cursor');
    expect(codeOf(() => pageParams(new URL('https://x/?cursor=1e3')))).toBe('invalid_cursor');
    expect(codeOf(() => pageParams(new URL('https://x/?cursor=1.0')))).toBe('invalid_cursor');
    expect(codeOf(() => pageParams(new URL('https://x/?limit=0')))).toBe('invalid_limit');
    expect(codeOf(() => pageParams(new URL('https://x/?limit=101')))).toBe('invalid_limit');
    expect(codeOf(() => pageParams(new URL('https://x/?limit=1.5')))).toBe('invalid_limit');
    expect(codeOf(() => pageParams(new URL('https://x/?limit=1.0')))).toBe('invalid_limit');
  });
});

describe('strictObject', () => {
  it('rejects unknown fields', () => {
    expect(codeOf(() => strictObject({ a: 'x', extra: 1 }, { a: 'string' }))).toBe('invalid_json');
  });

  it('applies Go zero values for missing fields', () => {
    expect(strictObject({}, { name: 'string', count: 'number', flag: 'boolean' })).toEqual({
      name: '',
      count: 0,
      flag: false,
    });
  });

  it('rejects wrong types, null for required scalars and non-integer numbers', () => {
    expect(codeOf(() => strictObject({ name: 5 }, { name: 'string' }))).toBe('invalid_json');
    expect(codeOf(() => strictObject({ name: null }, { name: 'string' }))).toBe('invalid_json');
    expect(codeOf(() => strictObject({ count: 1.5 }, { count: 'number' }))).toBe('invalid_json');
  });

  it('treats optional null as absent', () => {
    expect(strictObject({ when: null }, { when: 'string?' })).toEqual({ when: undefined });
  });
});
