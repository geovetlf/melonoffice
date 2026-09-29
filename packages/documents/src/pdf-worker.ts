/**
 * Reads a PDF's text inside a worker thread (Document Engine DOC-2, ADR-0079). Started only by
 * `pdfText` in `extract.ts`, which gives it the bytes and its limits, bounds its memory and ends
 * it when it takes too long. The file is untrusted: PDF.js runs here with no network, no worker
 * fetch, no fonts loaded from the system, and nothing it prints reaches the service's logs.
 *
 * Only syntax Node can strip is used here, so the same file runs from `src` (tests) and, compiled,
 * from `dist`.
 */
import { parentPort, workerData } from 'node:worker_threads';

interface Input {
  readonly bytes: Uint8Array;
  readonly maxPages: number;
  readonly maxCharacters: number;
}

type Output =
  | {
      readonly status: 'text';
      readonly text: string;
      readonly pages: number;
      readonly truncated: boolean;
    }
  | {
      readonly status: 'failed';
      readonly code: 'unreadable' | 'encrypted' | 'too_many_pages';
      readonly pages?: number;
    };

interface TextItem {
  readonly str?: unknown;
  readonly hasEOL?: unknown;
}

// PDF.js warns on the console about what it cannot do (render, load fonts). Those lines could
// carry details of the file; none leaves this thread.
const quiet = (): void => undefined;
console.log = quiet;
console.info = quiet;
console.warn = quiet;
console.error = quiet;
console.debug = quiet;

async function read(input: Input): Promise<Output> {
  // The PDF.js worker's code runs in this thread (its "fake worker"): no second worker, nothing
  // loaded from a path or a URL.
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: input.bytes,
    // PDF.js 6 no longer compiles code from a file; kept false should an older copy be loaded.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    verbosity: 0,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  let document: Awaited<typeof task.promise>;
  try {
    document = await task.promise;
  } catch (error) {
    const name = (error as { name?: unknown }).name;
    return { status: 'failed', code: name === 'PasswordException' ? 'encrypted' : 'unreadable' };
  }
  const pages = document.numPages;
  if (pages > input.maxPages) return { status: 'failed', code: 'too_many_pages', pages };
  const out: string[] = [];
  let length = 0;
  let truncated = false;
  for (let n = 1; n <= pages && !truncated; n += 1) {
    const page = await document.getPage(n);
    const content = await page.getTextContent();
    for (const item of content.items as readonly TextItem[]) {
      if (typeof item.str !== 'string') continue;
      const piece = item.hasEOL === true ? `${item.str}\n` : item.str;
      out.push(piece);
      length += piece.length;
      if (length > input.maxCharacters) {
        truncated = true;
        break;
      }
    }
    out.push('\n');
    length += 1;
    page.cleanup();
  }
  const text = out.join('');
  return {
    status: 'text',
    text: truncated ? text.slice(0, input.maxCharacters) : text,
    pages,
    truncated,
  };
}

const port = parentPort;
if (port !== null) {
  read(workerData as Input).then(
    (output) => port.postMessage(output),
    () => port.postMessage({ status: 'failed', code: 'unreadable' } satisfies Output),
  );
}
