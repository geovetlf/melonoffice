import type { ToolDefinition, ToolSchema, ToolVersion } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { canonicalJson, digestOf, sameDigest } from './canonical.js';
import { ToolError } from './errors.js';
import { idempotencyKeyOf } from './executor.js';
import {
  checkToolDefinition,
  checkToolVersion,
  invocationModesOf,
  isHumanInvocable,
  isRuntimeInvocable,
  toolCanRun,
  TOOL_TRANSITIONS,
} from './model.js';
import {
  createToolRegistry,
  defaultToolRegistry,
  CONVERSATION_HANDOFF_TOOL,
  HANDOFF_REASON_CODES,
  FOLLOW_UP_SCHEDULE_TOOL,
  MESSAGE_SEND_TOOL,
  TOOL_CATALOGUE,
} from './registry.js';
import { isForbiddenField, looksLikeCredential, schemaProblem, validate } from './schema.js';

const INPUT: ToolSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', maxLength: 200, minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 20 },
    tags: { type: 'array', items: { type: 'string', maxLength: 20 }, maxItems: 3 },
    filter: {
      type: 'object',
      properties: { language: { type: 'string', maxLength: 5, enum: ['en', 'es'] } },
    },
  },
  required: ['query'],
};

const version = (overrides: Partial<ToolVersion> = {}): ToolVersion =>
  ({
    toolId: 'web_search',
    version: 1,
    nameKey: 'tools.web_search.name',
    descriptionKey: 'tools.web_search.description',
    category: 'research',
    action: 'search',
    mutating: false,
    inputSchema: INPUT,
    outputSchema: {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 0 } },
      required: ['count'],
    },
    permissions: ['organization.read'],
    credentials: [{ provider: 'search_provider', scopes: ['search.read'] }],
    riskLevel: 'low',
    approvalPolicy: 'auto',
    approvalTtlSeconds: 3600,
    timeoutMs: 5000,
    retryPolicy: { maxAttempts: 2, backoffMs: 0 },
    provider: { kind: 'internal', id: 'fixture' },
    environments: ['dev'],
    ...overrides,
  }) as ToolVersion;

const definition = (versions: ToolVersion[] = [version()]): ToolDefinition => ({
  id: 'web_search' as ToolDefinition['id'],
  status: 'active',
  versions,
});

/** Credential-shaped test values, built at run time so secret scanners do not flag the source. */
const fake = (...parts: string[]): string => parts.join('');

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ToolError) return error.detail ?? error.code;
    throw error;
  }
  return 'accepted';
};

describe('tool definition and versions', () => {
  it('accepts a complete version and definition', () => {
    expect(codeOf(() => checkToolVersion(version()))).toBe('accepted');
    expect(codeOf(() => checkToolDefinition(definition()))).toBe('accepted');
  });

  it('refuses a version without bounds, scope or valid policy', () => {
    const cases: [Partial<ToolVersion>, string][] = [
      [{ toolId: 'Web Search' as ToolVersion['toolId'] }, 'toolId'],
      [{ version: 0 }, 'version'],
      [{ riskLevel: 'extreme' as never }, 'riskLevel'],
      [{ approvalPolicy: 'maybe' as never }, 'approvalPolicy'],
      [{ timeoutMs: 0 }, 'timeoutMs'],
      [{ timeoutMs: 11 * 60_000 }, 'timeoutMs'],
      [{ approvalTtlSeconds: 10 }, 'approvalTtlSeconds'],
      [{ retryPolicy: { maxAttempts: 0, backoffMs: 0 } }, 'retryPolicy'],
      [{ environments: [] }, 'environments'],
      [{ environments: ['production' as never] }, 'environments'],
      [{ permissions: ['tool.anything' as never] }, 'permissions'],
      [{ provider: { kind: 'remote' as never, id: 'x' } }, 'provider'],
      [{ departmentTypes: [] }, 'departmentTypes'],
      [{ inputSchema: { type: 'string', maxLength: 3 } }, 'inputSchema:object'],
    ];
    for (const [overrides, detail] of cases) {
      expect(codeOf(() => checkToolVersion(version(overrides)))).toBe(detail);
    }
  });

  it('holds credential references only: never a value, never a secret field', () => {
    const withValue = version({
      credentials: [{ provider: 'google', scopes: ['drive'], apiKey: 'x' } as never],
    });
    expect(codeOf(() => checkToolVersion(withValue))).toBe('credentials.0');
    const secretProvider = version({ credentials: [{ provider: 'client_secret', scopes: [] }] });
    expect(codeOf(() => checkToolVersion(secretProvider))).toBe('credentials.0.provider');
  });

  it('refuses a schema that could carry authority or credentials into a tool', () => {
    for (const field of ['organizationId', 'tenant_id', 'approved', 'role', 'apiKey', 'password']) {
      const schema: ToolSchema = {
        type: 'object',
        properties: { [field]: { type: 'string', maxLength: 10 } },
      };
      expect(schemaProblem(schema)).toBeDefined();
      expect(codeOf(() => checkToolVersion(version({ inputSchema: schema })))).toMatch(
        /^inputSchema:/,
      );
    }
  });

  it('numbers versions 1, 2, 3… for their own tool', () => {
    const v2 = version({ version: 2, riskLevel: 'medium' });
    expect(codeOf(() => checkToolDefinition(definition([version(), v2])))).toBe('accepted');
    expect(codeOf(() => checkToolDefinition(definition([v2])))).toBe('versions.0.version');
    expect(
      codeOf(() =>
        checkToolDefinition(
          definition([version({ toolId: 'other_tool' as ToolVersion['toolId'] })]),
        ),
      ),
    ).toBe('versions.0.toolId');
  });

  it('runs only active tools, and archived is final', () => {
    expect(toolCanRun('active')).toBe(true);
    for (const status of ['draft', 'paused', 'disabled', 'archived'] as const) {
      expect(toolCanRun(status)).toBe(false);
    }
    expect(TOOL_TRANSITIONS.archived).toEqual([]);
  });
});

describe('tool registry', () => {
  it('resolves one exact version, with no "latest"', () => {
    const registry = createToolRegistry([definition([version(), version({ version: 2 })])]);
    expect(registry.resolve('web_search', 2)?.version.version).toBe(2);
    expect(registry.resolve('web_search', 3)).toBeUndefined();
    expect(registry.resolve('web_search', 0)).toBeUndefined();
    expect(registry.resolve('unknown', 1)).toBeUndefined();
  });

  it('is immutable once built', () => {
    const source = definition();
    const registry = createToolRegistry([source]);
    const resolved = registry.resolve('web_search', 1);
    expect(Object.isFrozen(resolved?.version.inputSchema)).toBe(true);
    (source.versions[0] as { riskLevel: string }).riskLevel = 'critical';
    expect(registry.resolve('web_search', 1)?.version.riskLevel).toBe('low');
  });

  it('refuses duplicates and a changed published version', () => {
    expect(codeOf(() => createToolRegistry([definition(), definition()]))).toBe(
      'duplicate:web_search',
    );
    const changed = definition([version({ riskLevel: 'medium' })]);
    expect(codeOf(() => createToolRegistry([changed], [version()]))).toBe(
      'published_version_changed:web_search@1',
    );
    expect(codeOf(() => createToolRegistry([definition()], [version()]))).toBe('accepted');
  });

  it('ships message_send, conversation_handoff and follow_up_schedule: real tools with executors, none invented', () => {
    expect(TOOL_CATALOGUE.map((t) => t.id)).toEqual([
      'message_send',
      'conversation_handoff',
      'follow_up_schedule',
    ]);
    expect(defaultToolRegistry().list()).toEqual([
      MESSAGE_SEND_TOOL,
      CONVERSATION_HANDOFF_TOOL,
      FOLLOW_UP_SCHEDULE_TOOL,
    ]);
    const v = defaultToolRegistry().resolve('message_send', 1)?.version;
    expect(v).toMatchObject({
      action: 'send',
      mutating: true,
      permissions: ['conversation.send'],
      approvalPolicy: 'auto',
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'external', id: 'channel' },
      environments: ['dev'],
      invocationModes: ['human'],
    });
    // Its input names the conversation and the reserved message: no recipient, account or token.
    expect(Object.keys((v?.inputSchema as { properties: object }).properties)).toEqual([
      'conversationId',
      'messageId',
    ]);
  });

  it("gives an agent's replies their own runtime-only versions, never a person's (CV-6B)", () => {
    const registry = defaultToolRegistry();
    const supervised = registry.resolve('message_send', 2)?.version;
    const autonomous = registry.resolve('message_send', 3)?.version;
    for (const v of [supervised, autonomous]) {
      expect(v).toMatchObject({
        action: 'send',
        permissions: ['conversation.send'],
        retryPolicy: { maxAttempts: 1, backoffMs: 0 },
        provider: { kind: 'external', id: 'channel' },
        environments: ['dev'],
        invocationModes: ['runtime'],
      });
      expect(v?.inputSchema).toEqual(registry.resolve('message_send', 1)?.version.inputSchema);
    }
    // A supervised agent's reply always waits on a person's approval.
    expect(supervised?.approvalPolicy).toBe('approval_required');
    expect(autonomous?.approvalPolicy).toBe('auto');
    const handoff = registry.resolve('conversation_handoff', 1)?.version;
    expect(handoff).toMatchObject({
      permissions: ['conversation.manage'],
      credentials: [],
      invocationModes: ['runtime'],
      provider: { kind: 'internal', id: 'conversation' },
    });
    expect(
      (handoff?.inputSchema as unknown as { properties: { reason: { enum: readonly string[] } } })
        .properties.reason.enum,
    ).toEqual([...HANDOFF_REASON_CODES]);
  });
});

describe('invocation modes (ADR-0034)', () => {
  it('defaults to the runtime only: a person never invokes a tool that does not say so', () => {
    expect(invocationModesOf(version())).toEqual(['runtime']);
    expect(isRuntimeInvocable(version())).toBe(true);
    expect(isHumanInvocable(version())).toBe(false);
    const human = version({ invocationModes: ['human'] });
    expect(isHumanInvocable(human)).toBe(true);
    // Saying `human` does not keep `runtime`: each mode is explicit.
    expect(isRuntimeInvocable(human)).toBe(false);
    const both = version({ invocationModes: ['runtime', 'human'] });
    expect([isRuntimeInvocable(both), isHumanInvocable(both)]).toEqual([true, true]);
  });

  it('refuses unknown, empty or duplicate modes', () => {
    for (const invocationModes of [[], ['gia'], ['human', 'human'], ['Human'], [1]]) {
      expect(codeOf(() => checkToolVersion(version({ invocationModes } as never)))).toMatch(
        /^invocationModes/,
      );
    }
  });

  it('never lets a human tool need an approval or belong to a department', () => {
    expect(
      codeOf(() =>
        checkToolVersion(
          version({ invocationModes: ['human'], approvalPolicy: 'approval_required' }),
        ),
      ),
    ).toBe('invocationModes.human_approval');
    expect(
      codeOf(() =>
        checkToolVersion(
          version({ invocationModes: ['human'], departmentTypes: ['finance' as never] }),
        ),
      ),
    ).toBe('invocationModes.human_department');
  });
});

describe('input validation', () => {
  it('accepts input that matches the closed schema', () => {
    expect(validate(INPUT, { query: 'melons', limit: 5, filter: { language: 'es' } })).toEqual({
      valid: true,
    });
  });

  it('refuses types, bounds, unknown and missing fields', () => {
    const cases: [unknown, string][] = [
      [{}, 'missing'],
      [{ query: 3 }, 'type'],
      [{ query: '' }, 'too_short'],
      [{ query: 'x'.repeat(201) }, 'too_long'],
      [{ query: 'x', limit: 50 }, 'out_of_range'],
      [{ query: 'x', limit: 1.5 }, 'type'],
      [{ query: 'x', tags: ['a', 'b', 'c', 'd'] }, 'too_many'],
      [{ query: 'x', filter: { language: 'fr' } }, 'not_allowed'],
      [{ query: 'x', extra: true }, 'unknown_field'],
      [[], 'type'],
      [null, 'type'],
    ];
    for (const [value, code] of cases) {
      expect(validate(INPUT, value)).toMatchObject({ valid: false, code });
    }
  });

  it('refuses authority fields at any depth, before anything else', () => {
    for (const field of [
      'organizationId',
      'tenantId',
      'userId',
      'approvalId',
      'override',
      'role',
    ]) {
      expect(validate(INPUT, { query: 'x', [field]: 'y' })).toMatchObject({
        valid: false,
        code: 'forbidden_field',
      });
      expect(validate(INPUT, { query: 'x', filter: { [field]: 'y' } })).toMatchObject({
        code: 'forbidden_field',
      });
    }
    expect(isForbiddenField('Organization_ID')).toBe(true);
    expect(isForbiddenField('query')).toBe(false);
  });

  it('refuses credentials passed as input, by name or by value', () => {
    for (const field of ['apiKey', 'access_token', 'clientSecret', 'password']) {
      expect(validate(INPUT, { query: 'x', [field]: 'y' })).toMatchObject({
        code: 'forbidden_field',
      });
    }
    for (const value of [
      'Bearer abc.def.ghi',
      fake('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxIn0', '.c2lnbmF0dXJl'),
      '-----BEGIN PRIVATE KEY-----',
      fake('sk', '-abcdefghijklmnopqrstuvwxyz123456'),
      fake('AI', 'zaSyA1234567890abcdefghijklmnopqrstuv'),
      fake('gh', 'p_abcdefghijklmnopqrstuvwxyz0123456789'),
      fake('AK', 'IAABCDEFGHIJKLMNOP'),
    ]) {
      expect(looksLikeCredential(value)).toBe(true);
      expect(validate(INPUT, { query: value })).toMatchObject({ code: 'credential_value' });
    }
    expect(looksLikeCredential('find melon growers in Valencia')).toBe(false);
  });

  it('refuses objects that are not plain data', () => {
    expect(validate(INPUT, new Map([['query', 'x']]))).toMatchObject({ code: 'type' });
    expect(validate(INPUT, Object.create({ query: 'x' }) as unknown)).toMatchObject({
      code: 'type',
    });
  });
});

describe('digests and idempotency', () => {
  it('digests the same data the same way, whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    expect(digestOf({ a: 1, b: 2 })).toBe(digestOf({ b: 2, a: 1 }));
    expect(digestOf({ a: 1 })).not.toBe(digestOf({ a: 2 }));
    expect(sameDigest(digestOf(1), digestOf(1))).toBe(true);
    expect(sameDigest(digestOf(1), digestOf(2))).toBe(false);
    expect(sameDigest(digestOf(1), 'short')).toBe(false);
  });

  it('gives one key per execution, node and exact tool version', () => {
    const e = '0b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b';
    const key = idempotencyKeyOf(e, 'send', 'web_search', 1);
    expect(key).toBe(idempotencyKeyOf(e, 'send', 'web_search', 1));
    expect(key).not.toBe(idempotencyKeyOf(e, 'send', 'web_search', 2));
    expect(key).not.toBe(idempotencyKeyOf(e, 'other', 'web_search', 1));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('follow_up_schedule (TL-1, ADR-0068)', () => {
  it("is a person's own internal tool: low risk, no credential, never the runtime's", () => {
    const v = defaultToolRegistry().resolve('follow_up_schedule', 1)?.version;
    expect(v).toMatchObject({
      category: 'crm',
      action: 'schedule',
      mutating: true,
      permissions: ['follow_up.manage'],
      credentials: [],
      riskLevel: 'low',
      approvalPolicy: 'auto',
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'internal', id: 'follow_up' },
      environments: ['dev'],
      invocationModes: ['human'],
    });
    // Its input is the follow-up's own fields: no organization, person or credential in it.
    expect(Object.keys((v?.inputSchema as { properties: object }).properties)).toEqual([
      'requestKey',
      'contactId',
      'opportunityId',
      'type',
      'title',
      'description',
      'date',
      'time',
      'assignedTo',
      'source',
    ]);
    expect(defaultToolRegistry().resolve('follow_up_schedule', 3)).toBeUndefined();
  });

  it("version 2 is an agent's (ADR-0084): the runtime's only, approved by a person every time", () => {
    const v = defaultToolRegistry().resolve('follow_up_schedule', 2)?.version;
    expect(v).toMatchObject({
      category: 'crm',
      action: 'schedule',
      mutating: true,
      permissions: ['follow_up.manage'],
      credentials: [],
      riskLevel: 'low',
      approvalPolicy: 'approval_required',
      approvalTtlSeconds: 172_800,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'internal', id: 'follow_up' },
      environments: ['dev'],
      invocationModes: ['runtime'],
    });
    // No assignee, opportunity or description: only what the person approves, from an agent.
    const schema = v?.inputSchema as {
      properties: Record<string, { enum?: readonly string[] }>;
      required: readonly string[];
    };
    expect(Object.keys(schema.properties)).toEqual([
      'requestKey',
      'contactId',
      'type',
      'title',
      'date',
      'time',
      'source',
    ]);
    expect(schema.properties.source?.enum).toEqual(['agent']);
    expect(schema.required).toContain('source');
  });
});
