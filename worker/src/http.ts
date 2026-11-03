/** HTTP helpers: envelope format, error mapping, strict request-body parsing. */

export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const REFRESH_COOKIE = 'rk_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/** Error carrying a protocol error code; index.ts renders it as {"error":{"code","message"}}. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** Build (without throwing) a protocol error. */
export function fail(status: number, code: string): HttpError {
  return new HttpError(status, code);
}

/** Success envelope: {"data": ...}. */
export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/** 204 response (optionally with extra headers such as Set-Cookie). */
export function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers });
}

/** Error envelope, matching the former Go server exactly. */
export function errorResponse(
  error: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  const known = error instanceof HttpError ? error : new HttpError(500, 'internal_error');
  return new Response(
    JSON.stringify({
      error: { code: known.code, message: known.code.replaceAll('_', ' ') },
    }),
    {
      status: known.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
    },
  );
}

export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'raw'
  | 'string?'
  | 'number?'
  | 'boolean?';

export type Shape = Record<string, FieldType>;

type FieldValue<T extends FieldType> = T extends 'string'
  ? string
  : T extends 'number'
    ? number
    : T extends 'boolean'
      ? boolean
      : T extends 'raw'
        ? unknown
        : T extends 'string?'
          ? string | undefined
          : T extends 'number?'
            ? number | undefined
            : T extends 'boolean?'
              ? boolean | undefined
              : never;

export type BodyOf<S extends Shape> = { [K in keyof S]: FieldValue<S[K]> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strict object validation, matching Go's json.Decoder with
 * DisallowUnknownFields: unknown fields, wrong types and non-integer numbers
 * are rejected with 400 invalid_json. Missing required scalars keep their zero
 * value (Go unmarshals those into zero values), while explicit null for a
 * required scalar is rejected like Go's type-mismatch error.
 */
export function strictObject<S extends Shape>(value: unknown, shape: S): BodyOf<S> {
  if (!isRecord(value)) throw fail(400, 'invalid_json');

  for (const key of Object.keys(value)) {
    if (!(key in shape)) throw fail(400, 'invalid_json');
  }

  const out: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(shape)) {
    const optional = type.endsWith('?');
    const base = (optional ? type.slice(0, -1) : type) as 'string' | 'number' | 'boolean' | 'raw';
    const raw = value[key];

    if (raw === undefined) {
      out[key] = optional ? undefined : base === 'number' ? 0 : base === 'boolean' ? false : base === 'raw' ? null : '';
      continue;
    }
    if (optional && raw === null) {
      out[key] = undefined;
      continue;
    }
    if (base === 'raw') {
      out[key] = raw;
      continue;
    }
    if (typeof raw !== base) throw fail(400, 'invalid_json');
    if (base === 'number' && !Number.isInteger(raw)) throw fail(400, 'invalid_json');
    out[key] = raw;
  }
  return out as unknown as BodyOf<S>;
}

async function readBodyText(request: Request): Promise<string> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    throw fail(413, 'body_too_large');
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) throw fail(413, 'body_too_large');
  return new TextDecoder().decode(buffer);
}

/** Read, size-limit, JSON-parse and strictly validate a request body. */
export async function readBody<S extends Shape>(
  request: Request,
  shape: S,
): Promise<BodyOf<S>> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    throw fail(400, 'invalid_json');
  }
  const text = await readBodyText(request);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw fail(400, 'invalid_json');
  }
  return strictObject(value, shape);
}

/** Array-typed body field (any element shape is validated by the caller). */
export function arrayField(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw fail(400, 'invalid_json');
  return value;
}

/** Paged query parameters (`cursor` >= 0, `limit` 1..100, defaults 0/100). */
export function pageParams(url: URL): { cursor: number; limit: number } {
  let cursor = 0;
  const rawCursor = url.searchParams.get('cursor');
  if (rawCursor !== null && rawCursor !== '') {
    // Go used strconv.ParseInt: only plain decimal digits are accepted, so
    // `0x10`, `1e3`, `1.0` or `%202` must not pass.
    if (!/^\d+$/.test(rawCursor)) throw fail(400, 'invalid_cursor');
    const parsed = Number(rawCursor);
    if (!Number.isSafeInteger(parsed)) throw fail(400, 'invalid_cursor');
    cursor = parsed;
  }

  let limit = 100;
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit !== null && rawLimit !== '') {
    if (!/^\d{1,3}$/.test(rawLimit)) throw fail(400, 'invalid_limit');
    const parsed = Number(rawLimit);
    if (parsed < 1 || parsed > 100) throw fail(400, 'invalid_limit');
    limit = parsed;
  }
  return { cursor, limit };
}

/** Set-Cookie value for the rotating refresh token. */
export function refreshCookie(value: string, maxAgeSeconds: number, origin: string): string {
  const secure = origin.startsWith('https://') ? '; Secure' : '';
  return (
    `${REFRESH_COOKIE}=${value}; Path=${REFRESH_COOKIE_PATH}; Max-Age=${maxAgeSeconds}; ` +
    `HttpOnly; SameSite=Strict${secure}`
  );
}

/** Set-Cookie value that deletes the refresh token cookie. */
export function clearRefreshCookie(origin: string): string {
  return refreshCookie('', 0, origin);
}

/** Read one cookie value from the request headers. */
export function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    if (trimmed.slice(0, separator) === name) return trimmed.slice(separator + 1);
  }
  return null;
}

/** RFC3339 timestamp with second precision (used for expiresAt values). */
export function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate the configured RK_ORIGIN (same rule as the former Go server): it must
 * be an exact origin with no path/query/fragment/credentials, and HTTPS is
 * required unless the host is loopback. Returns a human-readable problem or null.
 */
export function originProblem(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return 'RK_ORIGIN must be an absolute origin (for example https://keys.example.com)';
  }
  if (url.username !== '' || url.password !== '') return 'RK_ORIGIN must not contain credentials';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'RK_ORIGIN must use http or https';
  }
  if (url.origin !== origin) return 'RK_ORIGIN must be an exact origin without a path, query or fragment';
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return 'RK_ORIGIN must use https outside local development';
  }
  return null;
}
