/**
 * Reads a server-sent events body (R4, ADR-0077): the `data` of each event, in order, as text.
 * Comments, ids and event names are skipped; multi-line data is joined with a newline, as the
 * format says. Only the format lives here, never a provider's meaning, so each adapter reads its
 * own events from the data. More than `maxBytes` in all is an error, like any oversized answer.
 */
export class ServerSentEventsTooLarge extends Error {
  constructor() {
    super('server_sent_events_too_large');
  }
}

export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let read = 0;
  let data: string[] = [];
  const lineOf = function* (line: string): Generator<string> {
    if (line === '') {
      if (data.length > 0) yield data.join('\n');
      data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') return;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    data.push(value);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read > maxBytes) throw new ServerSentEventsTooLarge();
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.search(/\r\n|\r|\n/)) !== -1) {
        // A `\r` that ends the chunk may be half of a `\r\n`: wait for the next one.
        if (end === buffer.length - 1 && buffer.endsWith('\r')) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + (buffer.startsWith('\r\n', end) ? 2 : 1));
        yield* lineOf(line);
      }
    }
    buffer += decoder.decode();
    // The last event, when the body ends without a blank line.
    if (buffer.length > 0) yield* lineOf(buffer);
    yield* lineOf('');
  } finally {
    // Stops the download when the reader stops early.
    await reader.cancel().catch(() => undefined);
  }
}
