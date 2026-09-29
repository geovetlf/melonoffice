import { Worker } from 'node:worker_threads';
import { DOCX_CONTENT_TYPE } from './content.js';
import { DocxError, docxText, MAX_EXTRACTED_CHARACTERS } from './docx.js';

/**
 * Reading the text of an uploaded PDF or Word document with local, open-source code (Document
 * Engine DOC-2, ADR-0079). Nothing here calls a model or the network: a PDF with no text layer
 * comes back as empty text, and the document service decides what to do with it.
 */

/** The most pages of a PDF that are read. A longer PDF is refused as `too_many_pages`. */
export const MAX_PDF_PAGES = 200;
/** How long reading one PDF may take before its worker is ended. */
export const PDF_TIMEOUT_MS = 20_000;
/**
 * The worker's heap: a PDF that needs more is `too_large`. Sized for the api's 512 MiB instance,
 * which also holds the upload itself and serves other requests: reading text needs far less.
 */
export const PDF_WORKER_HEAP_MB = 192;

/** Why a file's text could not be read. Closed codes, never a message. */
export type TextExtractionFailure =
  'unreadable' | 'too_large' | 'timeout' | 'encrypted' | 'too_many_pages';

/**
 * What reading a file gave: its text (possibly blank: a scanned PDF has none), how many pages a
 * PDF has, and whether the text was cut at the limit; or why it could not be read.
 */
export type TextExtraction =
  | {
      readonly status: 'text';
      readonly text: string;
      readonly pages?: number;
      readonly truncated: boolean;
    }
  | {
      readonly status: 'failed';
      readonly code: TextExtractionFailure;
      readonly pages?: number;
    };

/** The types whose text is read by a library. */
export type ReadableContentType = 'application/pdf' | typeof DOCX_CONTENT_TYPE;

/** Reads a PDF's or a DOCX's text. Never throws: a failure is a code. */
export interface TextExtractor {
  extract(contentType: ReadableContentType, bytes: Uint8Array): Promise<TextExtraction>;
}

export interface PdfTextOptions {
  readonly timeoutMs?: number;
  readonly maxPages?: number;
  readonly maxCharacters?: number;
  readonly heapMb?: number;
}

/**
 * The worker's script: the TypeScript source under tests (Node strips its types), the compiled
 * file once built.
 */
const WORKER_URL = new URL(
  import.meta.url.endsWith('.ts') ? './pdf-worker.ts' : './pdf-worker.js',
  import.meta.url,
);

const pageCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * What the worker answered, rebuilt from checked fields only: anything else, or text past the
 * limit, is not passed on as it came.
 */
function outputOf(value: unknown, maxCharacters: number): TextExtraction {
  const unreadable: TextExtraction = { status: 'failed', code: 'unreadable' };
  if (typeof value !== 'object' || value === null) return unreadable;
  const v = value as Record<string, unknown>;
  const pages = pageCount(v.pages);
  const withPages = pages === undefined ? {} : { pages };
  if (v.status === 'text' && typeof v.text === 'string' && typeof v.truncated === 'boolean') {
    const cut = v.text.length > maxCharacters;
    return {
      status: 'text',
      text: cut ? v.text.slice(0, maxCharacters) : v.text,
      ...withPages,
      truncated: v.truncated || cut,
    };
  }
  if (v.status === 'failed' && (v.code === 'unreadable' || v.code === 'encrypted')) {
    return { status: 'failed', code: v.code };
  }
  if (v.status === 'failed' && v.code === 'too_many_pages') {
    return { status: 'failed', code: 'too_many_pages', ...withPages };
  }
  return unreadable;
}

/**
 * At most this many PDFs are read at once, each in its own worker: one worker's heap is a large
 * part of a small instance's memory. Others wait their turn, at most as long as a read may take.
 */
export const MAX_CONCURRENT_PDF_READS = 1;

/** A counting semaphore whose waits give up after a time. */
function createSlots(size: number) {
  let free = size;
  const waiting: (() => void)[] = [];
  return {
    async acquire(ms: number): Promise<boolean> {
      if (free > 0) {
        free -= 1;
        return true;
      }
      return new Promise<boolean>((resolve) => {
        const turn = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          const at = waiting.indexOf(turn);
          if (at >= 0) waiting.splice(at, 1);
          resolve(false);
        }, ms);
        waiting.push(turn);
      });
    },
    release(): void {
      const next = waiting.shift();
      if (next === undefined) free += 1;
      else next();
    },
  };
}

/**
 * A PDF's text, read by PDF.js in a worker thread of its own: a bounded heap, a wall-clock limit
 * after which it is ended, at most `maxPages` pages and `maxCharacters` characters. A crash, an
 * exhausted heap or a malformed answer is a failure code; nothing the worker says is trusted.
 */
export function pdfText(bytes: Uint8Array, options: PdfTextOptions = {}): Promise<TextExtraction> {
  const timeoutMs = options.timeoutMs ?? PDF_TIMEOUT_MS;
  const heapMb = options.heapMb ?? PDF_WORKER_HEAP_MB;
  const maxCharacters = options.maxCharacters ?? MAX_EXTRACTED_CHARACTERS;
  return new Promise<TextExtraction>((resolve) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(WORKER_URL, {
        workerData: {
          bytes,
          maxPages: options.maxPages ?? MAX_PDF_PAGES,
          maxCharacters,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: heapMb,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        // Its output is its own: nothing it prints reaches this process's logs.
        stdout: true,
        stderr: true,
        env: {},
      });
    } catch {
      resolve({ status: 'failed', code: 'unreadable' });
      return;
    }
    worker.stdout.resume();
    worker.stderr.resume();
    const finish = (result: TextExtraction) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: 'failed', code: 'timeout' }), timeoutMs);
    worker.once('message', (message: unknown) => finish(outputOf(message, maxCharacters)));
    worker.once('error', (error: unknown) =>
      finish({
        status: 'failed',
        code:
          (error as { code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY'
            ? 'too_large'
            : 'unreadable',
      }),
    );
    worker.once('exit', () => finish({ status: 'failed', code: 'unreadable' }));
  });
}

/**
 * Reads PDFs with PDF.js (in a worker, `maxConcurrent` at a time) and DOCX with the built-in zip
 * and text reader. A PDF that waits longer than a read may take for its turn is `timeout`.
 */
export function createTextExtractor(
  options: PdfTextOptions & { readonly maxConcurrent?: number } = {},
): TextExtractor {
  const slots = createSlots(options.maxConcurrent ?? MAX_CONCURRENT_PDF_READS);
  const waitMs = options.timeoutMs ?? PDF_TIMEOUT_MS;
  return Object.freeze({
    async extract(contentType: ReadableContentType, bytes: Uint8Array): Promise<TextExtraction> {
      if (contentType === 'application/pdf') {
        if (!(await slots.acquire(waitMs))) return { status: 'failed', code: 'timeout' };
        try {
          return await pdfText(bytes, options);
        } finally {
          slots.release();
        }
      }
      if (contentType !== DOCX_CONTENT_TYPE) return { status: 'failed', code: 'unreadable' };
      try {
        return { status: 'text', ...docxText(bytes) };
      } catch (error) {
        return {
          status: 'failed',
          code: error instanceof DocxError ? error.code : 'unreadable',
        };
      }
    },
  } satisfies TextExtractor);
}
