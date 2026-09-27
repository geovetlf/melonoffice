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
