/**
 * Comercial's lists come one page at a time (ADR-0061): a page says whether more follow and the
 * cursor to ask for them. The cursor is the API's, opaque here: passed back as it came.
 */
export interface PageRequest {
  /** The previous page's `nextCursor`; absent for the first page. */
  readonly cursor?: string;
  /** How many records the page holds, at most; absent for the API's own page size. */
  readonly limit?: number;
}

/** Adds the page to a list's query string. */
export function pageQuery(query: URLSearchParams, page: PageRequest = {}): URLSearchParams {
  if (page.cursor !== undefined) query.set('cursor', page.cursor);
  if (page.limit !== undefined) query.set('limit', String(page.limit));
  return query;
}
