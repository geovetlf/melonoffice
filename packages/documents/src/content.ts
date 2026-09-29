import type { DocumentContentType, DocumentId, OrganizationId } from '@melonoffice/domain';
import { nameBasedUuid } from '@melonoffice/execution';
import { createHash } from 'node:crypto';
import { DocumentError } from './errors.js';

/**
 * What a document may be (ADR-0078): a closed list of types, a size limit and a checked name.
 * The declared type is never trusted alone: the bytes must look like that type.
 */

/** The largest document accepted, in bytes (10 MB). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_NAME_LENGTH = 200;

/** Text files: valid UTF-8, no NUL. Their text may be given to Company Brain. */
export const TEXT_CONTENT_TYPES: readonly DocumentContentType[] = Object.freeze([
  'text/plain',
  'text/markdown',
  'text/csv',
]);

export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const DOCUMENT_CONTENT_TYPES: readonly DocumentContentType[] = Object.freeze([
  ...TEXT_CONTENT_TYPES,
  'application/pdf',
  DOCX_CONTENT_TYPE,
]);

export const isTextContentType = (type: DocumentContentType): boolean =>
  TEXT_CONTENT_TYPES.includes(type);

// Control characters, and the bidirectional overrides that make a name read as another one
// (`factura‮fdp.exe`), are never part of a name.
// eslint-disable-next-line no-control-regex
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩/\\]/;
const MEDIA_TYPE = /^([a-z0-9.+-]+\/[a-z0-9.+-]+)$/;
const UTF8_CHARSET = /^charset\s*=\s*"?(utf-8)"?$/;

/** The name as it is stored: trimmed, 1 to 200 characters, no control characters or slashes. */
export function checkDocumentName(value: unknown): string {
  if (typeof value !== 'string') throw new DocumentError('invalid_document', 'name');
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_DOCUMENT_NAME_LENGTH || NAME_FORBIDDEN.test(name)) {
    throw new DocumentError('invalid_document', 'name');
  }
  try {
    // A lone surrogate is not text: it could not be written into a download's header.
    encodeURIComponent(name);
  } catch {
    throw new DocumentError('invalid_document', 'name');
  }
  return name;
}

/**
 * The declared type, from the list only. A text type may say `charset=utf-8`; no other parameter
 * is accepted, since nothing else is honoured.
 */
export function checkContentType(value: unknown): DocumentContentType {
  if (typeof value !== 'string' || value.length > 200) {
    throw new DocumentError('unsupported_type');
  }
  const [type = '', ...parameters] = value
    .toLowerCase()
    .split(';')
    .map((part) => part.trim());
  const media = MEDIA_TYPE.exec(type)?.[1];
  if (media === undefined || !DOCUMENT_CONTENT_TYPES.includes(media as DocumentContentType)) {
    throw new DocumentError('unsupported_type');
  }
  const contentType = media as DocumentContentType;
  for (const parameter of parameters) {
    if (!isTextContentType(contentType) || !UTF8_CHARSET.test(parameter)) {
      throw new DocumentError('unsupported_type');
    }
  }
  return contentType;
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);

/** `%PDF-` */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
/** `PK\x03\x04`: a zip archive, which every DOCX is. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * Checks that the bytes are what the type says, and returns a text file's text. A PDF must start
 * with `%PDF-` and a DOCX with a zip header; a text file must be valid UTF-8 without NUL. Nothing
 * else is read from a PDF or a DOCX.
 */
export function checkContent(
  contentType: DocumentContentType,
  bytes: Uint8Array,
): { readonly text?: string } {
  if (bytes.length === 0) throw new DocumentError('invalid_document', 'empty');
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new DocumentError('document_too_large');
  if (contentType === 'application/pdf') {
    if (!startsWith(bytes, PDF_MAGIC)) throw new DocumentError('invalid_document', 'content');
    return {};
  }
  if (contentType === DOCX_CONTENT_TYPE) {
    if (!startsWith(bytes, ZIP_MAGIC)) throw new DocumentError('invalid_document', 'content');
    return {};
  }
  if (bytes.includes(0)) throw new DocumentError('invalid_document', 'content');
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    throw new DocumentError('invalid_document', 'content');
  }
}

export const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** The same content in the same organization is always the same document. */
export const documentIdFor = (organizationId: OrganizationId, sha256: string): DocumentId =>
  nameBasedUuid('melonoffice.document', [organizationId, sha256]) as DocumentId;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isDocumentId = (value: unknown): value is DocumentId =>
  typeof value === 'string' && UUID.test(value);

/**
 * Where a document's bytes are kept. Built here from two ids only, never from anything a client
 * sent, so a name cannot reach another organization's objects or climb a path.
 */
export function storageKeyOf(organizationId: OrganizationId, id: DocumentId): string {
  if (!UUID.test(organizationId) || !UUID.test(id)) {
    throw new DocumentError('invalid_document', 'key');
  }
  return `organizations/${organizationId}/documents/${id}`;
}

/**
 * A `content-disposition` for downloading `name` as an attachment: a plain ASCII fallback and the
 * exact name in RFC 8187 form. Every character outside a small safe set is replaced or
 * percent-encoded, so no quote, semicolon or line break of a name can reach the header.
 */
export function attachmentDisposition(name: string): string {
  const fallback = name.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, MAX_DOCUMENT_NAME_LENGTH);
  const encoded = encodeURIComponent(name).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback === '' ? 'document' : fallback}"; filename*=UTF-8''${encoded}`;
}
