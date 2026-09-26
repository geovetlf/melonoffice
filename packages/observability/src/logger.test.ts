import { describe, expect, it } from 'vitest';
import { createLogger, isLogLevel, REDACTED } from './logger.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const sink = (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>);
  return { lines, sink };
}

const fixedNow = () => new Date('2026-09-26T00:00:00.000Z');

describe('createLogger', () => {
  it('writes one JSON entry with severity, message, service and time', () => {
    const { lines, sink } = capture();
    createLogger({ service: 'api', sink, now: fixedNow }).info('started', { port: 8080 });

    expect(lines).toEqual([
      {
        severity: 'INFO',
        message: 'started',
        service: 'api',
        time: '2026-09-26T00:00:00.000Z',
        port: 8080,
      },
    ]);
  });

  it('drops entries below the configured level', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ service: 'api', level: 'warn', sink });
    logger.debug('hidden');
    logger.info('hidden');
    logger.warn('shown');
    logger.error('shown');

    expect(lines.map((line) => line.severity)).toEqual(['WARNING', 'ERROR']);
  });

  it('adds child bindings to every entry', () => {
    const { lines, sink } = capture();
    createLogger({ service: 'worker', sink }).child({ requestId: 'r-1' }).info('handled');

    expect(lines[0]).toMatchObject({ requestId: 'r-1', service: 'worker' });
  });

  it('redacts sensitive fields, including nested ones', () => {
    const { lines, sink } = capture();
    createLogger({ service: 'api', sink }).info('login', {
      password: 'x',
      headers: { Authorization: 'Bearer y', accept: 'json' },
      apiKey: 'z',
    });

    expect(lines[0]).toMatchObject({
      password: REDACTED,
      headers: { Authorization: REDACTED, accept: 'json' },
      apiKey: REDACTED,
    });
  });

  it('does not let fields override the reserved keys', () => {
    const { lines, sink } = capture();
    createLogger({ service: 'api', sink }).info('real', { message: 'fake', severity: 'DEBUG' });

    expect(lines[0]).toMatchObject({ message: 'real', severity: 'INFO' });
  });

  it('serialises errors', () => {
    const { lines, sink } = capture();
    createLogger({ service: 'api', sink }).error('failed', { error: new Error('boom') });

    expect(lines[0]?.error).toMatchObject({ name: 'Error', message: 'boom' });
  });
});

describe('isLogLevel', () => {
  it('accepts only known levels', () => {
    expect(isLogLevel('debug')).toBe(true);
    expect(isLogLevel('verbose')).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
    expect(isLogLevel('toString')).toBe(false);
  });
});
