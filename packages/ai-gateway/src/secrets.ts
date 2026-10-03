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

/** Lowercase, without accents, with `_`, `-` and `.` as spaces: `api_key` reads `api key`. */
const foldName = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .trim();

/**
 * Names of a credential, in Spanish and English: a password, a PIN, an access or API key, a
 * token, a secret. "Clave" alone is also "key" as in "mensaje clave", so it counts only as a key
 * of an access, an account, a panel, a system, the wifi or a card.
 */
const CREDENTIAL_NAME =
  /\b(?:contrasenas?|passwords?|passwd|passcode|passphrase|pin|pins|tokens?|otp|cvv|cvc|secrets?|secreto|secretos|credencial(?:es)?|credentials?|(?:api|secret|access|private|clave)\s+keys?|claves?\s+(?:de\s+(?:acceso|ingreso|la\s+cuenta|la\s+tarjeta|wifi|wi\s?fi|seguridad)|del?\s+(?:panel|sistema|usuario|admin|administrador|correo|banco|wifi|wi\s?fi)|wifi|wi\s?fi)|(?:usuario|user|login)\s+y\s+(?:clave|contrasena|password))\b/;

/**
 * Whether a name, such as a company memory fact's label or key, is the name of a credential
 * (G-7). A value cannot tell a password from a product code; its name can.
 */
export function looksLikeCredentialName(name: string): boolean {
  return CREDENTIAL_NAME.test(foldName(name));
}

/**
 * A credential written as `name: value` or `name = value`, as a line of data reads it, even inside
 * JSON. The value is one run of at least 4 characters with a digit or a symbol, so prose such as
 * "contraseña: no la tengo" is not one.
 */
const VALUE_AFTER = /^[ \t]*["'“«]?([^\s"'”»,;]{4,})/;
const VALUE_LIKE = /[0-9]|[^\p{L}\p{N}\s]/u;

function labelledSpans(text: string): readonly { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (let at = text.search(/[:=]/); at !== -1;) {
    const value = VALUE_AFTER.exec(text.slice(at + 1, at + 1 + 512));
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    // Only the name right before the separator: not a word from an earlier sentence or field.
    const tail =
      text
        .slice(Math.max(lineStart, at - 60), at)
        .split(/[.!?;,()[\]{}"':=]/)
        .pop() ?? '';
    const words = foldName(tail).split(/\s+/).slice(-6).join(' ');
    if (value?.[1] !== undefined && looksLikeCredentialName(words) && VALUE_LIKE.test(value[1])) {
      const end = at + 1 + value[0].length;
      spans.push({ start: end - value[1].length, end });
      // Spans never overlap: the search goes on after this value.
      at = end - 1;
    }
    const next = text.slice(at + 1).search(/[:=]/);
    at = next === -1 ? -1 : at + 1 + next;
  }
  return spans;
}

/** Whether text gives a credential's value under its name, such as `Contraseña: Brasa-7!`. */
export function carriesLabelledSecret(text: string): boolean {
  return labelledSpans(text).length > 0;
}

/**
 * Free text with anything that looks like a credential replaced by `[redacted]`, for text a
 * model is given as data, such as a customer's message (ADR-0037). Text that still looks like a
 * secret afterwards is dropped whole. A heuristic, like `looksLikeSecretText`, not a full DLP.
 */
export function redactSecretText(text: string): string {
  let clean = text;
  for (const pattern of SECRET_SPANS) clean = clean.replace(pattern, REDACTED);
  // A credential under its name (G-7): the name stays, the value goes.
  for (const span of [...labelledSpans(clean)].reverse()) {
    clean = `${clean.slice(0, span.start)}${REDACTED}${clean.slice(span.end)}`;
  }
  return looksLikeSecretText(clean) ? REDACTED : clean;
}
