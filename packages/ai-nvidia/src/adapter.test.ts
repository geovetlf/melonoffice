import {
  costMicroUsd,
  createProviderRegistry,
  CREDIT_RATE,
  creditsFor,
  DEFAULT_MODEL_POLICY,
  ProviderCredential,
  routeModel,
  type CredentialResolver,
  type ProviderAdapter,
  type ProviderCall,
  type ProviderStreamEvent,
} from '@melonoffice/ai-gateway';
import { createAICostEngine, llmPricing, llmUsage } from '@melonoffice/ai-usage';
import type { AIModelDefinition, AIProviderDefinition } from '@melonoffice/domain';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createNvidiaAdapter,
  errorKindOfStatus,
  NVIDIA_HOSTED_BASE_URL,
  nvidiaRequestOf,
  NvidiaStreamChunks,
  outcomeOfNvidiaResponse,
  withoutReasoning,
} from './adapter.js';
import {
  NEMOTRON_3_NANO,
  NEMOTRON_3_NANO_MODEL,
  NVIDIA_MODELS,
  NVIDIA_PROVIDER,
} from './catalogue.js';
import { catalogueDrift, listNvidiaModels } from './discovery.js';

/**
 * The NVIDIA adapter (ADR-0080): NVIDIA's official OpenAI-compatible API, its key from a resolver,
 * every failure classified, `Retry-After` honoured, and nothing of the key or NVIDIA's messages
 * passed on. Mocks only: no call reaches NVIDIA.
 */

const T0 = new Date('2026-09-29T12:00:00.000Z');
/** Credential-shaped test values, built at run time so secret scanners do not flag the source. */
const fake = (...parts: string[]) => parts.join('');
const KEY = fake('nv', 'api-', 'test-only-value-0001');
const CHAT_URL = `${NVIDIA_HOSTED_BASE_URL}/chat/completions`;

const call = (overrides: Partial<ProviderCall> = {}): ProviderCall => ({
  requestId: 'req-1',
  idempotencyKey: 'k',
  model: { id: NEMOTRON_3_NANO, version: NEMOTRON_3_NANO_MODEL.version },
  capability: 'text_generation',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'Policy.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Data.' }] },
  ],
  outputModality: 'text',
  maxOutputTokens: 500,
  structuredOutput: false,
  credential: NVIDIA_PROVIDER.credential,
  deadline: new Date(T0.getTime() + 5_000),
  ...overrides,
});

const answer = (content: string, extra: Record<string, unknown> = {}) => ({
  id: 'nv-1',
  object: 'chat.completion',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content, reasoning_content: 'hidden thoughts' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1_000, completion_tokens: 200, total_tokens: 1_200 },
  ...extra,
});

function network(reply: () => Response | Promise<Response>) {
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), init });
    return reply();
  }) as typeof fetch;
  return { sent, fetchFn };
}

function resolver(values: (string | Error)[] = [KEY]) {
  const asked: string[] = [];
  const credentials: CredentialResolver = {
    async resolve(reference) {
      asked.push(reference.provider);
      const next = values.length > 1 ? values.shift() : values[0];
      if (next instanceof Error || next === undefined) throw next ?? new Error('none');
      return new ProviderCredential(next);
    },
  };
  return { asked, credentials };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function adapterWith(reply: () => Response | Promise<Response>, keys?: (string | Error)[]) {
  const net = network(reply);
  const keyring = resolver(keys);
  const adapter = createNvidiaAdapter({
    credentials: keyring.credentials,
    fetch: net.fetchFn,
    now: () => T0,
  });
  return { adapter, ...net, ...keyring };
}

const sse = (events: readonly (Record<string, unknown> | '[DONE]')[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const e of events) {
          controller.enqueue(encoder.encode(`data: ${e === '[DONE]' ? e : JSON.stringify(e)}\n\n`));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const delta = (content: string) => ({ id: 'nv-s', choices: [{ index: 0, delta: { content } }] });
const finish = { id: 'nv-s', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
const usage = { id: 'nv-s', choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } };

async function collect(stream: AsyncIterable<ProviderStreamEvent> | undefined) {
  if (stream === undefined) throw new Error('no stream');
  const events: ProviderStreamEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

describe('NVIDIA catalogue and terms', () => {
  it('is an official provider, DEV only, public data only, with its terms recorded', () => {
    const registry = createProviderRegistry({
      providers: [NVIDIA_PROVIDER],
      models: NVIDIA_MODELS,
      adapters: [createNvidiaAdapter({ credentials: resolver().credentials })],
    });
    const [only] = registry.models();
    expect(only?.model).toMatchObject({
      modelId: NEMOTRON_3_NANO,
      environments: ['dev'],
      maxSensitivity: 'public',
      toolUse: true,
      streaming: true,
      structuredOutput: false,
      terms: {
        offering: 'free_prototyping',
        production: 'requires_license',
        contentUse: 'may_be_used',
        verifiedAt: '2026-09-29',
      },
    });
    expect(only?.model.terms?.source).toMatch(/^https:\/\/assets\.ngc\.nvidia\.com\//);
  });

  it('cannot be registered for production, nor given anything but public data', () => {
    const adapters = [createNvidiaAdapter({ credentials: resolver().credentials })];
    const provider: AIProviderDefinition = { ...NVIDIA_PROVIDER, environments: ['dev', 'prod'] };
    for (const m of [
      { ...NEMOTRON_3_NANO_MODEL, environments: ['dev', 'prod'] },
      { ...NEMOTRON_3_NANO_MODEL, maxSensitivity: 'internal' },
    ] as AIModelDefinition[]) {
      expect(() =>
        createProviderRegistry({
          providers: [{ ...provider, maxSensitivity: 'internal' }],
          models: [m],
          adapters,
        }),
      ).toThrow();
    }
  });

  it('is routed only for public data, in DEV, and never alone: a compatible model follows it', () => {
    const other: AIProviderDefinition = {
      ...NVIDIA_PROVIDER,
      id: 'other',
      name: 'Other',
      credential: { provider: 'other', scopes: [] },
      maxSensitivity: 'confidential',
    };
    const otherModel: AIModelDefinition = {
      ...NEMOTRON_3_NANO_MODEL,
      providerId: 'other',
      modelId: 'other-text',
      maxSensitivity: 'confidential',
      pricing: {
        status: 'known',
        currency: 'USD',
        inputMicroUsdPerMillionTokens: 100_000,
        outputMicroUsdPerMillionTokens: 400_000,
        source: 'test fixture',
        asOf: '2026-09-29',
      },
    };
    delete (otherModel as { terms?: unknown }).terms;
    const fakeOther: ProviderAdapter = {
      providerId: 'other',
      adapterVersion: '1',
      generate: async () => ({ status: 'error', kind: 'unavailable' }),
      capabilities: () => ['text_generation'],
      health: async () => 'available',
    };
    const registry = createProviderRegistry({
      providers: [NVIDIA_PROVIDER, other],
      models: [...NVIDIA_MODELS, otherModel],
      adapters: [createNvidiaAdapter({ credentials: resolver().credentials }), fakeOther],
    });
    const request = {
      capability: 'text_generation' as const,
      inputModalities: ['text' as const],
      outputModality: 'text' as const,
      estimatedInputTokens: 100,
      maxOutputTokens: 100,
    };
    const publicCall = routeModel(registry, DEFAULT_MODEL_POLICY, 'dev', {
      ...request,
      sensitivity: 'public',
    });
    expect(
      publicCall.status === 'selected' &&
        publicCall.candidates.map((c) => `${c.provider.id}/${c.model.modelId}`),
    ).toEqual([`nvidia/${NEMOTRON_3_NANO}`, 'other/other-text']);
    // Internal data never reaches NVIDIA: only the other model is a candidate.
    const internalCall = routeModel(registry, DEFAULT_MODEL_POLICY, 'dev', {
      ...request,
      sensitivity: 'internal',
    });
    expect(
      internalCall.status === 'selected' && internalCall.candidates.map((c) => c.provider.id),
    ).toEqual(['other']);
    // A call that needs structured output is not claimed by NVIDIA.
    const structured = routeModel(registry, DEFAULT_MODEL_POLICY, 'dev', {
      ...request,
      sensitivity: 'public',
      structuredOutput: true,
    });
    expect(
      structured.status === 'selected' ? structured.candidates.map((c) => c.provider.id) : [],
    ).not.toContain('nvidia');
    // Nowhere but DEV.
    expect(
      routeModel(registry, DEFAULT_MODEL_POLICY, 'prod', { ...request, sensitivity: 'public' }),
    ).toEqual({ status: 'none', reason: 'environment_not_allowed' });
  });

  it('costs the provider nothing under free prototyping access; credits follow the one credit rule', () => {
    const tokens = { inputTokens: 1_000, outputTokens: 200 };
    expect(costMicroUsd(NEMOTRON_3_NANO_MODEL.pricing, tokens)).toBe(0);
    expect(creditsFor(0, CREDIT_RATE)).toBe(0);
    const cost = createAICostEngine().cost({
      capability: 'llm',
      provider: 'nvidia',
      model: NEMOTRON_3_NANO,
      operation: 'text_generation',
      pricing: llmPricing(NEMOTRON_3_NANO_MODEL.pricing),
      usage: llmUsage(NEMOTRON_3_NANO_MODEL.pricing, tokens),
      estimatedMicroUsd: 0,
    });
    expect(cost).toMatchObject({
      provider: 'nvidia',
      actualMicroUsd: 0,
      costBasis: 'provider_price_list',
    });
  });
});

describe('NVIDIA request and response', () => {
  it("sends the messages as chat messages under NVIDIA's model name, thinking off", () => {
    expect(nvidiaRequestOf(call())).toEqual({
      model: 'nvidia/nemotron-3-nano-30b-a3b',
      messages: [
        { role: 'system', content: 'Policy.' },
        { role: 'user', content: 'Data.' },
      ],
      max_tokens: 500,
      temperature: 0.2,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it('sends nothing it cannot: an unregistered model, media, a structured answer, no user', () => {
    expect(nvidiaRequestOf(call({ model: { id: 'llama-9', version: '1' } }))).toBeUndefined();
    expect(nvidiaRequestOf(call({ structuredOutput: true }))).toBeUndefined();
    expect(
      nvidiaRequestOf(
        call({
          messages: [
            {
              role: 'user',
              content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' } as never],
            },
          ],
        }),
      ),
    ).toBeUndefined();
    expect(
      nvidiaRequestOf(
        call({ messages: [{ role: 'system', content: [{ type: 'text', text: 'x' }] }] }),
      ),
    ).toBeUndefined();
  });

  it('reads the answer and its usage, never the reasoning', () => {
    expect(outcomeOfNvidiaResponse(answer('Hello.'))).toEqual({
      status: 'success',
      output: { text: 'Hello.' },
      usage: { inputTokens: 1_000, outputTokens: 200 },
      finishReason: 'stop',
      providerRequestId: 'nv-1',
    });
    expect(outcomeOfNvidiaResponse(answer('<think>secret plan</think>\n\nHello.'))).toMatchObject({
      output: { text: 'Hello.' },
    });
    expect(JSON.stringify(outcomeOfNvidiaResponse(answer('<think>x</think>Hi')))).not.toContain(
      'hidden thoughts',
    );
    // An unclosed trace is no answer.
    expect(outcomeOfNvidiaResponse(answer('<think>never ends'))).toMatchObject({
      kind: 'invalid_response',
    });
    expect(withoutReasoning('plain')).toBe('plain');
  });

  it('refuses a malformed answer: no usage, no choices, an unknown finish', () => {
    expect(outcomeOfNvidiaResponse({ ...answer('x'), usage: undefined })).toMatchObject({
      kind: 'invalid_response',
    });
    expect(outcomeOfNvidiaResponse({ ...answer('x'), choices: [] })).toMatchObject({
      kind: 'invalid_response',
    });
    const odd = answer('x');
    (odd.choices[0] as { finish_reason: string }).finish_reason = 'weird';
    expect(outcomeOfNvidiaResponse(odd)).toMatchObject({ kind: 'invalid_response' });
    expect(outcomeOfNvidiaResponse('nope')).toMatchObject({ kind: 'invalid_response' });
    const filtered = answer('x');
    (filtered.choices[0] as { finish_reason: string }).finish_reason = 'content_filter';
    expect(outcomeOfNvidiaResponse(filtered)).toMatchObject({ kind: 'content_policy' });
  });

  it('classifies every HTTP status', () => {
    expect(errorKindOfStatus(400)).toBe('invalid_request');
    expect(errorKindOfStatus(401)).toBe('authentication');
    expect(errorKindOfStatus(402)).toBe('authentication');
    expect(errorKindOfStatus(403)).toBe('authentication');
    expect(errorKindOfStatus(404)).toBe('unavailable');
    expect(errorKindOfStatus(408)).toBe('timeout');
    expect(errorKindOfStatus(422)).toBe('invalid_request');
    expect(errorKindOfStatus(429)).toBe('rate_limited');
    expect(errorKindOfStatus(500)).toBe('server_error');
    expect(errorKindOfStatus(503)).toBe('unavailable');
  });
});

describe('NVIDIA adapter', () => {
  it('authenticates with the key from Secret Manager and completes', async () => {
    const { adapter, sent, asked } = adapterWith(() => json(answer('Hello.')));
    expect(await adapter.generate(call())).toMatchObject({
      status: 'success',
      output: { text: 'Hello.' },
    });
    expect(sent[0]?.url).toBe(CHAT_URL);
    expect(new Headers(sent[0]?.init?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    expect(asked).toEqual(['nvidia']);
    // The key is read once and kept for a while.
    await adapter.generate(call());
    expect(asked).toEqual(['nvidia']);
  });

  it('fails as authentication without a key, never calling NVIDIA', async () => {
    const { adapter, sent } = adapterWith(() => json(answer('x')), [new Error('secret missing')]);
    expect(await adapter.generate(call())).toEqual({ status: 'error', kind: 'authentication' });
    expect(sent).toEqual([]);
  });

  it("refuses another provider's credential reference", async () => {
    const { adapter, sent } = adapterWith(() => json(answer('x')));
    expect(
      await adapter.generate(call({ credential: { provider: 'deepseek', scopes: [] } })),
    ).toMatchObject({ kind: 'authentication' });
    expect(sent).toEqual([]);
  });

  it('drops a refused key and reads it again next time', async () => {
    let status = 401;
    const { adapter, asked } = adapterWith(() =>
      status === 401 ? json({ error: 'bad' }, 401) : json(answer('ok')),
    );
    expect(await adapter.generate(call())).toMatchObject({
      kind: 'authentication',
      httpStatus: 401,
    });
    status = 200;
    expect(await adapter.generate(call())).toMatchObject({ status: 'success' });
    expect(asked).toEqual(['nvidia', 'nvidia']);
  });

  it("passes on a 429 with NVIDIA's Retry-After, and never its message", async () => {
    const { adapter } = adapterWith(() =>
      json({ error: { message: 'slow down, key nvapi-leak' } }, 429, { 'retry-after': '7' }),
    );
    const outcome = await adapter.generate(call());
    expect(outcome).toEqual({
      status: 'error',
      kind: 'rate_limited',
      httpStatus: 429,
      retryAfterMs: 7_000,
    });
    expect(JSON.stringify(outcome)).not.toContain('slow down');
  });

  it('marks a 429 without Retry-After as rate limited, for the policy backoff', async () => {
    const { adapter } = adapterWith(() => json({}, 429));
    expect(await adapter.generate(call())).toEqual({
      status: 'error',
      kind: 'rate_limited',
      httpStatus: 429,
    });
  });

  it('reports an outage, a missing model, spent trial credits and a context overflow', async () => {
    expect(await adapterWith(() => json({}, 503)).adapter.generate(call())).toMatchObject({
      kind: 'unavailable',
    });
    expect(await adapterWith(() => json({}, 500)).adapter.generate(call())).toMatchObject({
      kind: 'server_error',
    });
    expect(await adapterWith(() => json({}, 404)).adapter.generate(call())).toMatchObject({
      kind: 'unavailable',
      httpStatus: 404,
    });
    expect(await adapterWith(() => json({}, 402)).adapter.generate(call())).toMatchObject({
      kind: 'authentication',
      httpStatus: 402,
    });
    expect(
      await adapterWith(() =>
        json({ detail: "This model's maximum context length is 131072 tokens" }, 400),
      ).adapter.generate(call()),
    ).toMatchObject({ kind: 'context_overflow' });
  });

  it('times out at the deadline and on network failure', async () => {
    const { adapter, sent } = adapterWith(() => json(answer('x')));
    expect(await adapter.generate(call({ deadline: T0 }))).toMatchObject({ kind: 'timeout' });
    expect(sent).toEqual([]);
    const broken = createNvidiaAdapter({
      credentials: resolver().credentials,
      fetch: (async () => {
        throw new Error('ECONNRESET');
      }) as typeof fetch,
      now: () => T0,
    });
    expect(await broken.generate(call())).toMatchObject({ kind: 'network' });
  });

  it('refuses what it cannot serve: an unregistered model, a structured answer, another capability', async () => {
    const { adapter, sent } = adapterWith(() => json(answer('x')));
    expect(await adapter.generate(call({ model: { id: 'gone', version: '1' } }))).toMatchObject({
      kind: 'invalid_request',
    });
    expect(await adapter.generate(call({ structuredOutput: true }))).toMatchObject({
      kind: 'invalid_request',
    });
    expect(await adapter.generate(call({ capability: 'embeddings' }))).toMatchObject({
      kind: 'invalid_request',
    });
    expect(sent).toEqual([]);
  });

  it('refuses a malformed or oversized body', async () => {
    expect(
      await adapterWith(() => new Response('not json', { status: 200 })).adapter.generate(call()),
    ).toMatchObject({ kind: 'invalid_response' });
    expect(
      await adapterWith(() => json(answer('x'.repeat(1_100_000)))).adapter.generate(call()),
    ).toMatchObject({ kind: 'invalid_response' });
  });

  it('never shows the key: not in outcomes, not in inspection', async () => {
    const { adapter } = adapterWith(() => json({ error: KEY }, 500));
    const outcome = await adapter.generate(call());
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    expect(inspect(adapter, { depth: 5 })).not.toContain(KEY);
    expect(JSON.stringify(new ProviderCredential(KEY))).toBe('"[redacted]"');
  });

  it('takes a self-hosted NIM address over https only', () => {
    expect(() =>
      createNvidiaAdapter({ credentials: resolver().credentials, baseUrl: 'http://nim.local/v1' }),
    ).toThrow('invalid_nvidia_base_url');
    expect(() =>
      createNvidiaAdapter({
        credentials: resolver().credentials,
        baseUrl: 'https://nim.internal.example.com/v1',
      }),
    ).not.toThrow();
  });
});

describe('NVIDIA tool calling (R3, ADR-0076)', () => {
  const tools = [
    {
      name: 'lookup_contact',
      description: 'Finds a contact.',
      parameters: {
        type: 'object' as const,
        properties: { name: { type: 'string' as const, maxLength: 100 } },
        required: ['name'],
      },
    },
  ];

  it('offers tools as functions and reads the calls back', async () => {
    const { adapter, sent } = adapterWith(() =>
      json({
        id: 'nv-2',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'lookup_contact', arguments: '{"name":"Ana"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      }),
    );
    expect(await adapter.generate(call({ tools }))).toEqual({
      status: 'success',
      output: { toolCalls: [{ id: 'call_1', name: 'lookup_contact', arguments: { name: 'Ana' } }] },
      usage: { inputTokens: 50, outputTokens: 10 },
      finishReason: 'tool_use',
      providerRequestId: 'nv-2',
    });
    const body = JSON.parse(String(sent[0]?.init?.body)) as Record<string, unknown>;
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'lookup_contact',
          description: 'Finds a contact.',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string', maxLength: 100 } },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
    ]);
  });

  it('carries earlier calls and results in the conversation', () => {
    const body = nvidiaRequestOf(
      call({
        tools,
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Find Ana.' }] },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                call: { id: 'c1', name: 'lookup_contact', arguments: { name: 'Ana' } },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                callId: 'c1',
                name: 'lookup_contact',
                result: { found: true },
              },
            ],
          },
        ],
      }),
    );
    expect(body?.messages).toEqual([
      { role: 'user', content: 'Find Ana.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'lookup_contact', arguments: '{"name":"Ana"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"found":true}' },
    ]);
  });

  it('refuses malformed calls', () => {
    const bad = (toolCall: unknown) =>
      outcomeOfNvidiaResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: { role: 'assistant', content: null, tool_calls: [toolCall] },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    expect(
      bad({ id: 'c', type: 'function', function: { name: 'x', arguments: '{bad' } }),
    ).toMatchObject({
      kind: 'invalid_response',
    });
    expect(
      bad({ id: 'c c', type: 'function', function: { name: 'x', arguments: '{}' } }),
    ).toMatchObject({
      kind: 'invalid_response',
    });
    expect(
      bad({ id: 'c', type: 'function', function: { name: 'x', arguments: '[]' } }),
    ).toMatchObject({
      kind: 'invalid_response',
    });
  });
});

describe('NVIDIA streaming (R4, ADR-0077)', () => {
  it('passes the answer on as it comes, then the whole outcome with usage', async () => {
    const { adapter, sent } = adapterWith(() =>
      sse([delta('Hel'), delta('lo '), delta('world.'), finish, usage, '[DONE]']),
    );
    const events = await collect(adapter.stream?.(call()));
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Hello world.');
    expect(events.at(-1)).toEqual({
      type: 'end',
      outcome: {
        status: 'success',
        output: { text: 'Hello world.' },
        usage: { inputTokens: 10, outputTokens: 4 },
        finishReason: 'stop',
        providerRequestId: 'nv-s',
      },
    });
    const body = JSON.parse(String(sent[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('holds back and drops a reasoning trace, even split across chunks', async () => {
    const { adapter } = adapterWith(() =>
      sse([
        delta('<th'),
        delta('ink>plan'),
        delta(' more</think>\n'),
        delta('Answer.'),
        finish,
        usage,
      ]),
    );
    const events = await collect(adapter.stream?.(call()));
    const texts = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
    expect(texts.join('')).toBe('Answer.');
    expect(JSON.stringify(events)).not.toContain('plan');
    expect(events.at(-1)).toMatchObject({
      outcome: { status: 'success', output: { text: 'Answer.' } },
    });
  });

  it('fails a stream without usage, with a tool call, or that breaks', async () => {
    const noUsage = await collect(
      adapterWith(() => sse([delta('Hi'), finish])).adapter.stream?.(call()),
    );
    expect(noUsage.at(-1)).toMatchObject({ outcome: { kind: 'invalid_response' } });
    const chunks = new NvidiaStreamChunks();
    expect(
      chunks.add(JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'x' }] } }] })),
    ).toBeUndefined();
    expect(chunks.outcome()).toMatchObject({ kind: 'invalid_response' });
    const garbage = new NvidiaStreamChunks();
    expect(garbage.add('{not json')).toBeUndefined();
  });

  it('never streams tools or a structured answer, and reports a 429 with its Retry-After', async () => {
    const { adapter, sent } = adapterWith(() => json({}, 429, { 'retry-after': '2' }));
    const withTools = await collect(
      adapter.stream?.(
        call({
          tools: [
            {
              name: 'x',
              description: 'x',
              parameters: { type: 'object', properties: {} },
            },
          ],
        }),
      ),
    );
    expect(withTools).toEqual([
      { type: 'end', outcome: { status: 'error', kind: 'invalid_request' } },
    ]);
    expect(sent).toEqual([]);
    const limited = await collect(adapter.stream?.(call()));
    expect(limited).toEqual([
      {
        type: 'end',
        outcome: { status: 'error', kind: 'rate_limited', httpStatus: 429, retryAfterMs: 2_000 },
      },
    ]);
  });
});

describe('NVIDIA model discovery', () => {
  it('lists served models through GET /v1/models, and reports drift from the registry', async () => {
    const { fetchFn, sent } = network(() =>
      json({
        object: 'list',
        data: [{ id: 'meta/llama-x' }, { id: 'nvidia/other' }],
      }),
    );
    const listing = await listNvidiaModels({ credentials: resolver().credentials, fetch: fetchFn });
    expect(listing).toEqual({ status: 'listed', models: ['meta/llama-x', 'nvidia/other'] });
    expect(sent[0]?.url).toBe(`${NVIDIA_HOSTED_BASE_URL}/models`);
    expect(catalogueDrift(listing.status === 'listed' ? listing.models : [])).toEqual({
      missing: ['nvidia/nemotron-3-nano-30b-a3b'],
      unregistered: 2,
    });
    expect(catalogueDrift(['nvidia/nemotron-3-nano-30b-a3b'])).toEqual({
      missing: [],
      unregistered: 0,
    });
  });

  it('fails closed on a missing key, a 429, an outage or a malformed list', async () => {
    const list = (reply: () => Response, keys?: (string | Error)[]) =>
      listNvidiaModels({ credentials: resolver(keys).credentials, fetch: network(reply).fetchFn });
    expect(await list(() => json({ data: [] }), [new Error('x')])).toMatchObject({
      reason: 'authentication',
    });
    expect(await list(() => json({}, 429))).toMatchObject({ reason: 'rate_limited' });
    expect(await list(() => json({}, 503))).toMatchObject({ reason: 'unavailable' });
    expect(await list(() => json({ data: [{ id: 42 }] }))).toMatchObject({
      reason: 'invalid_response',
    });
  });
});
