// PDF.js ships no types for its worker module; only its presence matters (ADR-0079).
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
