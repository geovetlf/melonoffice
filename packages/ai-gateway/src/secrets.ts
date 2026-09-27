import { looksLikeCredential } from '@melonoffice/tools';

const BEARER = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const EDGES = /^[^A-Za-z0-9-]+|[^A-Za-z0-9_-]+$/g;

/**
 * Whether free text carries something that looks like a credential: a bearer token, a JWT, a
 * private key or a known API key shape, anywhere in it and whatever quotes surround it. Used on
 * prompts, metadata and model output alike (ADR-0027). A heuristic, not a full DLP.
 */
export function looksLikeSecretText(text: string): boolean {
  if (looksLikeCredential(text) || BEARER.test(text) || PRIVATE_KEY.test(text)) return true;
  return text.split(/\s+/).some((token) => looksLikeCredential(token.replace(EDGES, '')));
}

/** The same shapes as `looksLikeSecretText`, found anywhere in a text, to cut them out. */
const SECRET_SPANS: readonly RegExp[] = [
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
];

export const REDACTED = '[redacted]';

/**
 * Free text with anything that looks like a credential replaced by `[redacted]`, for text a
 * model is given as data, such as a customer's message (ADR-0037). Text that still looks like a
 * secret afterwards is dropped whole. A heuristic, like `looksLikeSecretText`, not a full DLP.
 */
export function redactSecretText(text: string): string {
  let clean = text;
  for (const pattern of SECRET_SPANS) clean = clean.replace(pattern, REDACTED);
  return looksLikeSecretText(clean) ? REDACTED : clean;
}
