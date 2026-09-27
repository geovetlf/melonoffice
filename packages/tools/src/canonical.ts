import { createHash, timingSafeEqual } from 'node:crypto';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A canonical JSON text: object keys sorted at every level and `undefined` members left out, so
 * two equal values always give the same text, whatever their key order.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number');
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256 of the canonical JSON, as 64 lowercase hex characters. */
export const digestOf = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

const DIGEST = /^[0-9a-f]{64}$/;

export const isDigest = (value: unknown): value is string =>
  typeof value === 'string' && DIGEST.test(value);

/** Compares two digests in constant time. Anything that is not a digest never matches. */
export function sameDigest(a: string, b: string): boolean {
  if (!isDigest(a) || !isDigest(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
