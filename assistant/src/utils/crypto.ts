import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

/** Accepts base64 or hex; must decode to exactly 32 bytes. */
export function parseKey(raw: string): Buffer {
  if (!raw) throw new Error('ENCRYPTION_KEY is not set');
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length}). Generate one with: openssl rand -base64 32`);
  }
  return buf;
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Malformed encrypted secret');
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Meta signs every webhook POST with HMAC-SHA256 over the *raw* body using the
 * app secret, sent as `X-Hub-Signature-256: sha256=<hex>`. Comparison must be
 * constant time, and the raw bytes must be used — re-serialising the parsed JSON
 * changes the bytes and the signature will never match.
 */
export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const expectedHex = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const expected = Buffer.from(`sha256=${expectedHex}`, 'utf8');
  const received = Buffer.from(header, 'utf8');
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
