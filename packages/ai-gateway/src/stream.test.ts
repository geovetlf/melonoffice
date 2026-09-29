import { describe, expect, it } from 'vitest';
import { readServerSentEvents, ServerSentEventsTooLarge } from './sse.js';
import { createTextChannel, SafeTextRelease } from './stream.js';

/** Credential-shaped test values, built at run time so secret scanners do not flag the source. */
const fake = (...parts: string[]) => parts.join('');

const body = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });

const all = async <T>(items: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
};

describe('server-sent events (R4, ADR-0077)', () => {
  it('reads each event’s data across chunk and line-ending boundaries', async () => {
    const events = await all(
      readServerSentEvents(
        body(
          ': comment\r',
          '\ndata: {"a"',
          ':1}\r',
          '\n\r\nevent: x\nid: 2\ndata: one\n',
          'data: two\n\ndata:last',
        ),
        1_000,
      ),
    );
    expect(events).toEqual(['{"a":1}', 'one\ntwo', 'last']);
  });

  it('refuses a body larger than allowed', async () => {
    await expect(all(readServerSentEvents(body('data: 0123456789\n\n'), 5))).rejects.toBeInstanceOf(
      ServerSentEventsTooLarge,
    );
  });
});

describe('safe text release (R4, ADR-0077)', () => {
  it('lets text out in whole words, and the rest only at the end', () => {
    const release = new SafeTextRelease();
    expect(release.add('Hel')).toBe('');
    expect(release.started).toBe(false);
    expect(release.add('lo wor')).toBe('Hello ');
    expect(release.add('ld, again')).toBe('world, ');
    expect(release.started).toBe(true);
    expect(release.rest()).toBe('again');
    expect(release.text).toBe('Hello world, again');
  });

  it('never lets out any part of a credential, a bearer token or a JWT', () => {
    const key = fake('sk', '-abcdefghijklmnopqrstuvwxyz123456');
    const jwt = fake('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0', '.', 'signaturevalue');
    for (const secret of [key, `Bearer ${fake('abcdef', 'ghijklmnop')}`, jwt]) {
      const release = new SafeTextRelease();
      let out = release.add('Here: ') ?? '';
      let refused = false;
      for (const ch of `${secret} and more`) {
        const piece = release.add(ch);
        if (piece === undefined) {
          refused = true;
          break;
        }
        out += piece;
      }
      expect(refused).toBe(true);
      const tail = secret.split(' ').at(-1) ?? secret;
      expect(out).not.toContain(tail.slice(0, 8));
    }
  });
});

describe('text channel', () => {
  it('hands pieces over in order, whether pushed before or after the reader waits', async () => {
    const channel = createTextChannel();
    channel.push('a');
    const reading = all(channel);
    await Promise.resolve();
    channel.push('b');
    channel.close();
    channel.push('ignored');
    expect(await reading).toEqual(['a', 'b']);
  });
});
