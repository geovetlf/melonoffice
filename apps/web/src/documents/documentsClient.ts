import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * Documents through the API (DOC-3, over DOC-1/DOC-2, ADR-0078/0079): the organization's uploaded
 * files, whether Company Brain read their text, and how. The screen shows what the API says; it
 * never reads a file's text itself.
 */

export type DocumentStatus = 'stored' | 'ingested' | 'not_ingested';

export interface DocumentView {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly status: DocumentStatus;
  readonly ingestion: string | null;
  readonly textSource: 'file' | 'library' | 'model' | null;
  readonly pages: number | null;
  readonly createdAt: string;
}

export interface DocumentPage {
  readonly documents: readonly DocumentView[];
  readonly nextCursor: string | null;
}

/** The file types the API accepts (ADR-0078), by extension for the file picker. */
export const ACCEPTED_TYPES: Readonly<Record<string, string>> = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
});

/** The API's limit (MAX_DOCUMENT_BYTES): checked here too, so a large file is not sent at all. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export class DocumentRequestError extends Error {
  override readonly name = 'DocumentRequestError';
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`document request failed: ${status}${code === undefined ? '' : ` ${code}`}`);
  }
}

/** A file's type as the API names it: the browser's, or from its extension when it has none. */
export function contentTypeOf(file: { readonly name: string; readonly type: string }) {
  if (Object.values(ACCEPTED_TYPES).includes(file.type)) return file.type;
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return ACCEPTED_TYPES[extension];
}

export interface DocumentsClient {
  list(cursor?: string): Promise<DocumentPage>;
  upload(file: Blob & { readonly name: string }, contentType: string): Promise<DocumentView>;
  /** The file's bytes, to save; the API sends them as an attachment. */
  content(id: string): Promise<Blob>;
}

export function createDocumentsClient(
  request: ReplyRequest,
  organizationId: string,
): DocumentsClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}/documents`;
  const failed = async (response: Response) => {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    return new DocumentRequestError(
      response.status,
      typeof body.error === 'string' ? body.error : undefined,
    );
  };
  return {
    async list(cursor) {
      const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      const response = await request(`${base}${query}`, {});
      if (!response.ok) throw await failed(response);
      const body = (await response.json()) as Partial<DocumentPage>;
      return { documents: body.documents ?? [], nextCursor: body.nextCursor ?? null };
    },
    async upload(file, contentType) {
      const response = await request(`${base}?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: file,
      });
      if (!response.ok) throw await failed(response);
      return ((await response.json()) as { document: DocumentView }).document;
    },
    async content(id) {
      const response = await request(`${base}/${encodeURIComponent(id)}/content`, {});
      if (!response.ok) throw await failed(response);
      return response.blob();
    },
  };
}
