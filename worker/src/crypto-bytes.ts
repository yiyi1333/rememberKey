/** Base64url primitives shared by the crypto helpers. */

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

function base64ToBytes(value: string): Uint8Array | null {
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode unpadded base64url and require the canonical re-encoding to equal the
 * input (the Go server rejects non-canonical encodings the same way).
 */
export function decode64Url(value: string): Uint8Array | null {
  if (!BASE64URL_PATTERN.test(value)) return null;
  const bytes = base64ToBytes(value);
  if (bytes === null) return null;
  if (bytesToBase64Url(bytes) !== value) return null;
  return bytes;
}

/** Decode unpadded base64url that must be exactly `length` bytes long. */
export function decode64(value: string, length: number): Uint8Array | null {
  const bytes = decode64Url(value);
  if (bytes === null || bytes.length !== length) return null;
  return bytes;
}

/** True when the decoded byte length of `value` falls within [min, max]. */
export function binaryRange(value: string, min: number, max: number): boolean {
  const bytes = decode64Url(value);
  if (bytes === null) return false;
  return bytes.length >= min && bytes.length <= max;
}
