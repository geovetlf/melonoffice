/**
 * What a page says when a request fails. Every client throws its own error class with the API's
 * refusal code; these turn one into the message a page shows, the same way on every page.
 */

/** A client's error class: an `Error` that may carry the API's refusal code. */
type RequestErrorClass = abstract new (...args: never[]) => Error & {
  readonly code?: string | undefined;
};

/**
 * The API's refusal code, when `error` is one of `kind` and the page has a message for the code;
 * `generic` otherwise.
 */
export function errorCode(
  error: unknown,
  kind: RequestErrorClass,
  known: ReadonlySet<string>,
): string {
  const code = error instanceof kind ? (error.code ?? 'generic') : 'generic';
  return known.has(code) ? code : 'generic';
}

/**
 * The message id for `error`: `<prefix>.error.<code>` when it is one of `kind` with a code, and
 * `<prefix>.error.generic` otherwise.
 */
export function errorMessage(error: unknown, kind: RequestErrorClass, prefix: string): string {
  return error instanceof kind && error.code !== undefined
    ? `${prefix}.error.${error.code}`
    : `${prefix}.error.generic`;
}
