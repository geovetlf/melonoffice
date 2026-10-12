import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The production server (`server.ts`) builds its options by hand, apart from the test app
 * (`test-api.ts`): an option the tests pass and the server forgets is green in CI and off in
 * every deployed environment. These checks read the server's source for the options that once
 * went missing.
 */
const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');

/** The source of the `conversations: { … }` options the server passes to the app. */
function conversationsOptions(): string {
  const start = server.indexOf('    conversations: {\n');
  expect(start).toBeGreaterThan(-1);
  const end = server.indexOf('\n    },\n', start);
  expect(end).toBeGreaterThan(start);
  return server.slice(start, end);
}

describe('the production server wires what the tests wire', () => {
  it('gives the conversations routes the channel templates (ADR-0046)', () => {
    // Without it every template route answers 503 and a person's template send is refused.
    expect(conversationsOptions()).toMatch(/^\s+templates,$/m);
  });
});
