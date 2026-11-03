/** Protocol primitives: base64url, hashing, Ed25519 verification, payload validators. */

import { binaryRange, bytesToBase64Url, decode64, decode64Url } from './crypto-bytes';

export { binaryRange, decode64, decode64Url };

const encoder = new TextEncoder();

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** SHA-256 hex digest, matching the Go server's digest(). */
export async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(result)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Random 32-byte token as base64url (no padding). */
export function token(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** RFC3339Nano UTC timestamp. */
export function now(): string {
  return new Date().toISOString();
}

/** Ed25519 detached signature verification (base64url pubkey/signature). */
export async function verify(
  publicKey: string,
  message: string,
  signature: string,
): Promise<boolean> {
  try {
    const rawKey = decode64(publicKey, 32);
    const rawSignature = decode64(signature, 64);
    if (rawKey === null || rawSignature === null) return false;
    const key = await crypto.subtle.importKey('raw', rawKey, { name: 'Ed25519' }, false, [
      'verify',
    ]);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, rawSignature, encoder.encode(message));
  } catch {
    return false;
  }
}

const ENVELOPE_KEYS = ['ciphertext', 'nonce', 'version', 'wrappedKey'] as const;
const WRAP_KEYS = ['ciphertext', 'nonce'] as const;
const BUNDLE_KEYS = ['passwordWrap', 'privateWrap', 'recoveryWrap', 'salt', 'version'] as const;

export interface Wrap {
  nonce: string;
  ciphertext: string;
}

export interface Bundle {
  version: number;
  salt: string;
  passwordWrap: Wrap;
  recoveryWrap: Wrap;
  privateWrap: Wrap;
}

export interface DeviceInput {
  id: string;
  name: string;
  publicKey: string;
  proof: string;
}

export interface OperationLike {
  operationId: string;
  id: string;
  baseRevision: number;
  deleted: boolean;
  envelope: string | null;
  signature: string;
}

function exactKeys(object: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(object);
  if (keys.length !== expected.length) return false;
  const set = new Set(keys);
  return expected.every((key) => set.has(key));
}

function parseWrap(value: unknown): Wrap | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const wrap = value as Record<string, unknown>;
  if (!exactKeys(wrap, WRAP_KEYS)) return null;
  if (typeof wrap.nonce !== 'string' || typeof wrap.ciphertext !== 'string') return null;
  if (!decode64(wrap.nonce, 24)) return null;
  return { nonce: wrap.nonce, ciphertext: wrap.ciphertext };
}

/** Validate a device record envelope against the 128 KiB / 96 KiB ciphertext limits. */
export function parseEnvelope(
  raw: string | null,
  deleted: boolean,
): { envelope: string | null } | null {
  if (deleted) return raw === null ? { envelope: null } : null;
  if (raw === null || raw.length > 128 * 1024) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (!exactKeys(envelope, ENVELOPE_KEYS)) return null;
  if (envelope.version !== 1) return null;
  if (typeof envelope.nonce !== 'string' || typeof envelope.ciphertext !== 'string') return null;
  if (typeof envelope.wrappedKey !== 'string') return null;
  if (!decode64(envelope.nonce, 24)) return null;
  if (!binaryRange(envelope.ciphertext, 16, 96 * 1024)) return null;
  if (!decode64(envelope.wrappedKey, 80)) return null;
  return { envelope: raw };
}

/** Strictly parse a device description from an untrusted JSON value. */
export function parseDevice(value: unknown): DeviceInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const device = value as Record<string, unknown>;
  if (!exactKeys(device, ['id', 'name', 'proof', 'publicKey'])) return null;
  if (
    typeof device.id !== 'string' ||
    typeof device.name !== 'string' ||
    typeof device.proof !== 'string' ||
    typeof device.publicKey !== 'string'
  ) {
    return null;
  }
  return {
    id: device.id,
    name: device.name,
    publicKey: device.publicKey,
    proof: device.proof,
  };
}

/** Device validation exactly as the Go server does it. */
export async function validDevice(
  account: string,
  signPublicKey: string,
  device: DeviceInput,
): Promise<boolean> {
  if (!isUuid(device.id)) return false;
  // Go's len() counts UTF-8 bytes, not UTF-16 units.
  const nameBytes = new TextEncoder().encode(device.name).length;
  if (nameBytes === 0 || nameBytes > 128) return false;
  if (!decode64(device.publicKey, 32)) return false;
  return verify(
    signPublicKey,
    `rememberKey:device:1:${account}:${device.id}:${device.publicKey}`,
    device.proof,
  );
}

/** Validate a key bundle (opaque ciphertext, but structurally checked). */
export function bundleValid(raw: string): Bundle | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const bundle = value as Record<string, unknown>;
  if (!exactKeys(bundle, BUNDLE_KEYS)) return null;
  if (bundle.version !== 1) return null;
  if (typeof bundle.salt !== 'string' || !decode64(bundle.salt, 16)) return null;

  const passwordWrap = parseWrap(bundle.passwordWrap);
  const recoveryWrap = parseWrap(bundle.recoveryWrap);
  const privateWrap = parseWrap(bundle.privateWrap);
  if (!passwordWrap || !recoveryWrap || !privateWrap) return null;
  if (!decode64(passwordWrap.ciphertext, 48)) return null;
  if (!decode64(recoveryWrap.ciphertext, 48)) return null;
  if (!binaryRange(privateWrap.ciphertext, 17, 4096)) return null;

  return { version: 1, salt: bundle.salt, passwordWrap, recoveryWrap, privateWrap };
}

/** Canonical signing message for a sync operation. */
export async function opMessage(accountId: string, op: OperationLike): Promise<string> {
  const envelopeHash = await digest(op.envelope ?? '');
  return (
    `rememberKey:op:1:${accountId}:${op.operationId}:${op.id}:${op.baseRevision}:` +
    `${op.deleted ? '1' : '0'}:${envelopeHash}`
  );
}

/** Canonical signing message for a key-bundle update. */
export async function bundleMessage(
  accountId: string,
  expectedVersion: number,
  bundleJson: string,
): Promise<string> {
  return (
    `rememberKey:bundle:1:${accountId}:${expectedVersion}:${await digest(bundleJson)}`
  );
}
