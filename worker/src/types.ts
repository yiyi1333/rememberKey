/** Bindings and shared types for the rememberKey Cloudflare Worker. */

export interface Env {
  /** D1 database binding (see migrations/). */
  DB: D1Database;
  /** Exact public Pages origin, e.g. https://keys.example.com (http://127.0.0.1:8788 in dev). */
  RK_ORIGIN: string;
  /** One-time bootstrap token that allows the first (admin) registration. */
  RK_BOOTSTRAP_TOKEN?: string;
}

/** Authenticated caller, derived from a Bearer access token. */
export interface Identity {
  account: string;
  device: string;
  family: string;
  role: string;
  /** Account Ed25519 signing public key (base64url). */
  signKey: string;
  /** SHA-256 hex of the presented access token (re-validated per sync operation). */
  tokenHash: string;
}

/** Everything a route handler needs, computed once per request. */
export interface RouteContext {
  env: Env;
  request: Request;
  url: URL;
  /** Decoded pathname with the `/api/v1` prefix removed (e.g. `/sync/changes`). */
  path: string;
  method: string;
}

/** Stored record row (D1 representation). */
export interface RecordRow {
  id: string;
  revision: number;
  deleted: number;
  envelope: string | null;
  signature: string;
  operation: string;
  base: number;
}
