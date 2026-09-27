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

  it('adds the organization, specialist and exact tool version of a tool call', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'api',
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    withCorrelation(logger, {
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      specialistId: '33333333-3333-4333-8333-333333333333',
      toolId: 'send_email',
      toolVersion: 2,
    }).info('tool');
    withCorrelation(logger, { toolId: 'bad tool', toolVersion: 0 }).info('bad');
    expect(lines[0]).toMatchObject({
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      specialistId: '33333333-3333-4333-8333-333333333333',
      toolId: 'send_email',
      toolVersion: 2,
    });
    expect(lines[1]).not.toHaveProperty('toolId');
    expect(lines[1]).not.toHaveProperty('toolVersion');
  });

  it('adds the provider and model of an AI call, and drops malformed ones', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'api',
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    withCorrelation(logger, { provider: 'alpha', model: 'alpha/alpha-small' }).info('ai');
    withCorrelation(logger, { provider: 'Bad Provider', model: 'x\n{"y":1}' }).info('bad');
    expect(lines[0]).toMatchObject({ provider: 'alpha', model: 'alpha/alpha-small' });
    expect(lines[1]).not.toHaveProperty('provider');
    expect(lines[1]).not.toHaveProperty('model');
  });

  it('adds the plan and the workflow version it came from', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'api',
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    withCorrelation(logger, {
      planId: '44444444-4444-4444-8444-444444444444',
      workflowId: 'weekly_report',
      workflowVersion: 3,
    }).info('plan');
    withCorrelation(logger, { planId: 'bad id', workflowVersion: 0 }).info('bad');
    expect(lines[0]).toMatchObject({
      planId: '44444444-4444-4444-8444-444444444444',
      workflowId: 'weekly_report',
      workflowVersion: 3,
    });
    expect(lines[1]).not.toHaveProperty('planId');
    expect(lines[1]).not.toHaveProperty('workflowVersion');
  });
});
