import type { AIRequestProblem, AIModelRequest } from './request.js';
import type { AIResponse } from './response.js';
import { looksLikeSecretText } from './secrets.js';

/**
 * Streaming through the AI Gateway (R4, ADR-0077). A streamed call is the same call as
 * `generate` or `assist`: the same checks, authorization, policy, routing, credits, retries,
 * fallback, cost, usage and audit. It only lets the caller read the answer's text as it comes.
 */

/**
 * What a caller reads: pieces of the answer's text, then exactly one `done` with the same
 * response `generate` would have given. Text read before a `done` that is not `completed` is not
 * an answer and must be dropped.
 */
export type AIStreamEvent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'done'; readonly response: AIResponse };

/**
 * A streamed call is text only. Tool calls and structured answers are checked whole before
 * anything uses them, so a caller must never read one piece by piece: those calls use `generate`.
 */
export function streamRequestProblem(request: AIModelRequest): AIRequestProblem | undefined {
  if (
    request.outputModality !== 'text' ||
    request.tools !== undefined ||
    request.outputSchema !== undefined ||
    request.requirements?.structuredOutput === true ||
    request.requirements?.toolUse === true
  ) {
    return 'invalid_request';
  }
  return undefined;
}

/**
 * Holds a streamed answer's text back until it is safe to pass on. Text goes out only in whole
 * words (up to the last whitespace), and only once everything up to there has passed the same
 * credential check as a whole answer. A credential is one unbroken word, or a word after
 * `bearer`, so it is always seen whole before any of it leaves. What is held at the end goes out
 * only after the whole answer has been checked and charged.
 */
export class SafeTextRelease {
  #seen = '';
  #released = 0;

  /** Everything the model has said so far. */
  get text(): string {
    return this.#seen;
  }

  /** Whether any text has gone out, after which the call can no longer be retried. */
  get started(): boolean {
    return this.#released > 0;
  }

  /**
   * Takes a piece of text and returns what may go out now, or `undefined` when what was said
   * looks like it carries a credential (nothing more may go out, and the call fails).
   */
  add(text: string): string | undefined {
    this.#seen += text;
    const cut = lastWhitespace(this.#seen);
    if (cut <= this.#released) return '';
    const ready = this.#seen.slice(0, cut);
    if (looksLikeSecretText(ready)) return undefined;
    const out = ready.slice(this.#released);
    this.#released = cut;
    return out;
  }

  /** What is still held, to go out once the whole answer is checked. */
  rest(): string {
    const out = this.#seen.slice(this.#released);
    this.#released = this.#seen.length;
    return out;
  }
}

function lastWhitespace(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (/\s/.test(text[i] as string)) return i + 1;
  }
  return 0;
}

/**
 * A queue of text between the call and its reader: the call pushes as it goes, whether or not
 * anyone reads, and the reader takes pieces in order until it is closed.
 */
export interface TextChannel extends AsyncIterable<string> {
  push(text: string): void;
  close(): void;
}

export function createTextChannel(): TextChannel {
  const queue: string[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  return {
    push(text: string) {
      if (closed) return;
      queue.push(text);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
