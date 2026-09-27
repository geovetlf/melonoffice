import { describe, expect, it } from 'vitest';
import { withCorrelation } from './correlation.js';
import { createLogger } from './logger.js';

describe('withCorrelation', () => {
  it('adds the request, execution and node ids to every line, and drops malformed ones', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'api',
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    const correlated = withCorrelation(logger, {
      requestId: 'req-1',
      executionId: '0b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b',
      nodeId: 'bad id\n{"x":1}',
    });
    correlated.info('one');
    correlated.child({ step: 2 }).warn('two');
    expect(lines).toEqual([
      expect.objectContaining({
        message: 'one',
        requestId: 'req-1',
        executionId: '0b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b',
      }),
      expect.objectContaining({ message: 'two', step: 2, requestId: 'req-1' }),
    ]);
    expect(lines[0]).not.toHaveProperty('nodeId');
  });
});
