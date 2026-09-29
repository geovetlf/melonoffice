import {
  createModelPolicyCatalogue,
  createProviderRegistry,
  DEFAULT_MODEL_POLICY,
  ProviderCredential,
  routeModel,
  type CredentialResolver,
  type ProviderCall,
} from '@melonoffice/ai-gateway';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createDeepSeekAdapter,
  DEEPSEEK_API_URL,
  deepSeekRequestOf,
  describeSchema,
  errorKindOfStatus,
  outcomeOfDeepSeekResponse,
} from './adapter.js';
import { DEEPSEEK_MODELS, DEEPSEEK_PROVIDER } from './catalogue.js';

/**
 * The DeepSeek adapter (ADR-0072): DeepSeek's official chat completions API, its key from a
 * resolver, every failure classified, and nothing of the key or DeepSeek's messages passed on.
 */

const T0 = new Date('2026-09-29T12:00:00.000Z');
/** Credential-shaped test values, built at run time so secret scanners do not flag the source. */
const fake = (...parts: string[]) => parts.join('');
const KEY = fake('sk', '-deepseek-test-only-value-0001');

const call = (overrides: Partial<ProviderCall> = {}): ProviderCall => ({
  requestId: 'req-1',
  idempotencyKey: 'k',
  model: { id: 'deepseek-chat', version: 'current' },
  capability: 'text_generation',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'Policy.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Data.' }] },
  ],
  outputModality: 'text',
  maxOutputTokens: 500,
  structuredOutput: false,
  credential: DEEPSEEK_PROVIDER.credential,
  deadline: new Date(T0.getTime() + 5_000),
  ...overrides,
});

const answer = (content: string, extra: Record<string, unknown> = {}) => ({
  id: 'ds-1',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content, reasoning_content: 'hidden thoughts' },
      finish_reason: 'stop',
    },
  ],
  usage: {
    prompt_tokens: 1_000,
    completion_tokens: 200,
    prompt_cache_hit_tokens: 600,
    prompt_cache_miss_tokens: 400,
  },
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

describe('DeepSeek catalogue', () => {
  it('registers as an official provider, DEV only, up to internal data, prices unknown', () => {
    const registry = createProviderRegistry({
      providers: [DEEPSEEK_PROVIDER],
      models: DEEPSEEK_MODELS,
      adapters: [createDeepSeekAdapter(resolver())],
    });
    expect(registry.models().map((m) => m.model.modelId)).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
    expect(DEEPSEEK_PROVIDER.maxSensitivity).toBe('internal');
    expect(DEEPSEEK_MODELS.every((m) => m.pricing.status === 'unknown')).toBe(true);
    // Confidential data never reaches DeepSeek, whatever the policy allows.
    const policy = createModelPolicyCatalogue([]).resolve(undefined) ?? DEFAULT_MODEL_POLICY;
    expect(
      routeModel(registry, { ...policy, maxSensitivity: 'confidential' }, 'dev', {
        capability: 'text_generation',
        inputModalities: ['text'],
        outputModality: 'text',
        sensitivity: 'confidential',
        estimatedInputTokens: 100,
        maxOutputTokens: 100,
      }),
    ).toEqual({ status: 'none', reason: 'sensitivity_not_allowed' });
    // Nor anywhere but DEV.
    expect(
      routeModel(registry, policy, 'prod', {
        capability: 'text_generation',
        inputModalities: ['text'],
        outputModality: 'text',
        sensitivity: 'internal',
        estimatedInputTokens: 100,
        maxOutputTokens: 100,
      }),
    ).toEqual({ status: 'none', reason: 'environment_not_allowed' });
  });
});

describe('DeepSeek request and response', () => {
  it('sends the messages as chat messages, text only', () => {
    expect(deepSeekRequestOf(call())).toEqual({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Policy.' },
        { role: 'user', content: 'Data.' },
      ],
      max_tokens: 500,
      temperature: 0.2,
      stream: false,
    });
    expect(
      deepSeekRequestOf(
        call({
          messages: [
            { role: 'user', content: [{ type: 'image', ref: { type: 'file', id: 'f1' } }] },
          ],
        }),
      ),
    ).toBeUndefined();
    // A stored document (ADR-0079): DeepSeek has no such modality, so nothing is sent.
    expect(
      deepSeekRequestOf(
        call({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  mimeType: 'application/pdf',
                  ref: {
                    type: 'stored_document',
                    id: 'organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/documents/dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                  },
                  pages: 1,
                },
              ],
            },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it('asks for JSON with the expected shape when the answer is structured', () => {
    const body = deepSeekRequestOf(
      call({
        structuredOutput: true,
        outputSchema: {
          type: 'object',
          properties: {
            reply: { type: 'string' },
            tone: { type: 'string', enum: ['warm', 'formal'] },
            items: { type: 'array', items: { type: 'integer' }, nullable: true },
          },
          required: ['reply'],
        },
      }),
    );
    expect(body?.response_format).toEqual({ type: 'json_object' });
    expect((body?.messages as { content: string }[])[0]?.content).toBe(
      'Answer with one JSON object of this shape: object { "reply": string; "tone" (optional): one of "warm", "formal"; "items" (optional): array of integer or null }.',
    );
    expect(describeSchema({ type: 'boolean', nullable: true })).toBe('boolean or null');
  });

  it('reads the answer, cached input and usage, and never the reasoning', () => {
    expect(outcomeOfDeepSeekResponse(answer('Hola'), false)).toEqual({
      status: 'success',
      output: { text: 'Hola' },
      usage: { inputTokens: 1_000, outputTokens: 200, cachedInputTokens: 600 },
      finishReason: 'stop',
      providerRequestId: 'ds-1',
    });
    expect(outcomeOfDeepSeekResponse(answer('{"reply":"ok"}'), true)).toMatchObject({
      output: { structured: { reply: 'ok' } },
    });
    const text = JSON.stringify(outcomeOfDeepSeekResponse(answer('Hola'), false));
    expect(text).not.toContain('hidden thoughts');
  });

  it('refuses answers it cannot account for or read', () => {
    expect(outcomeOfDeepSeekResponse({ choices: [] }, false)).toEqual({
      status: 'error',
      kind: 'invalid_response',
    });
    expect(outcomeOfDeepSeekResponse(answer('x', { usage: {} }), false)).toMatchObject({
      kind: 'invalid_response',
    });
    const filtered = answer('x');
    (filtered.choices[0] as { finish_reason: string }).finish_reason = 'content_filter';
    expect(outcomeOfDeepSeekResponse(filtered, false)).toMatchObject({ kind: 'content_policy' });
    const busy = answer('x');
    (busy.choices[0] as { finish_reason: string }).finish_reason = 'insufficient_system_resource';
    expect(outcomeOfDeepSeekResponse(busy, false)).toMatchObject({ kind: 'unavailable' });
  });

  it('classifies HTTP statuses', () => {
    expect([400, 401, 402, 403, 408, 422, 429, 500, 503].map((s) => errorKindOfStatus(s))).toEqual([
      'invalid_request',
      'authentication',
      'authentication',
      'authentication',
      'timeout',
      'invalid_request',
      'rate_limited',
      'server_error',
      'unavailable',
    ]);
  });
});

describe('DeepSeek adapter', () => {
  it('calls the official endpoint with the key from the resolver, and keeps the key out', async () => {
    const { sent, fetchFn } = network(() => Response.json(answer('Hola')));
    const { asked, credentials } = resolver();
    const adapter = createDeepSeekAdapter({ credentials, fetch: fetchFn, now: () => T0 });
    const outcome = await adapter.generate(call());
    expect(outcome).toMatchObject({ status: 'success', output: { text: 'Hola' } });
    expect(sent[0]?.url).toBe(DEEPSEEK_API_URL);
    expect((sent[0]?.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(asked).toEqual(['deepseek']);
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    expect(inspect(outcome)).not.toContain(KEY);
    // The key is kept a while: a second call does not read it again.
    await adapter.generate(call());
    expect(asked).toHaveLength(1);
  });

  it('reads the key again after DeepSeek refuses it', async () => {
    let status = 401;
    const { fetchFn } = network(() =>
      status === 401 ? new Response('{}', { status }) : Response.json(answer('ok')),
    );
    const { asked, credentials } = resolver([fake('sk', '-old-key-value-000000001'), KEY]);
    const adapter = createDeepSeekAdapter({ credentials, fetch: fetchFn, now: () => T0 });
    expect(await adapter.generate(call())).toEqual({
      status: 'error',
      kind: 'authentication',
      httpStatus: 401,
    });
    status = 200;
    expect(await adapter.generate(call())).toMatchObject({ status: 'success' });
    expect(asked).toHaveLength(2);
  });

  it('is an authentication failure when the key cannot be read, and calls nothing', async () => {
    const { sent, fetchFn } = network(() => Response.json(answer('x')));
    const adapter = createDeepSeekAdapter({
      credentials: resolver([new Error('secret_not_found')]).credentials,
      fetch: fetchFn,
      now: () => T0,
    });
    expect(await adapter.generate(call())).toEqual({ status: 'error', kind: 'authentication' });
    expect(sent).toHaveLength(0);
  });

  it('tells a context overflow from other refusals, without passing the message on', async () => {
    const { fetchFn } = network(
      () =>
        new Response(
          JSON.stringify({
            error: { message: "This model's maximum context length is 65536 tokens" },
          }),
          { status: 400 },
        ),
    );
    const adapter = createDeepSeekAdapter({ credentials: resolver().credentials, fetch: fetchFn });
    expect(await adapter.generate(call())).toEqual({
      status: 'error',
      kind: 'context_overflow',
      httpStatus: 400,
    });
    const other = createDeepSeekAdapter({
      credentials: resolver().credentials,
      fetch: network(() => new Response('{"error":{"message":"bad"}}', { status: 422 })).fetchFn,
    });
    expect(await other.generate(call())).toEqual({
      status: 'error',
      kind: 'invalid_request',
      httpStatus: 422,
    });
  });

  it('refuses another provider’s credential, other capabilities and a spent deadline', async () => {
    const { sent, fetchFn } = network(() => Response.json(answer('x')));
    const adapter = createDeepSeekAdapter({
      credentials: resolver().credentials,
      fetch: fetchFn,
      now: () => T0,
    });
    expect(
      await adapter.generate(call({ credential: { provider: 'google_cloud', scopes: [] } })),
    ).toMatchObject({ kind: 'authentication' });
    expect(await adapter.generate(call({ capability: 'embeddings' }))).toMatchObject({
      kind: 'invalid_request',
    });
    expect(await adapter.generate(call({ deadline: T0 }))).toMatchObject({ kind: 'timeout' });
    expect(sent).toHaveLength(0);
  });

  it('turns a network failure and a rate limit into retryable kinds', async () => {
    const down = createDeepSeekAdapter({
      credentials: resolver().credentials,
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    expect(await down.generate(call())).toEqual({ status: 'error', kind: 'network' });
    const busy = createDeepSeekAdapter({
      credentials: resolver().credentials,
      fetch: network(() => new Response('{}', { status: 429 })).fetchFn,
    });
    expect(await busy.generate(call())).toEqual({
      status: 'error',
      kind: 'rate_limited',
      httpStatus: 429,
    });
  });
});

describe('DeepSeek function calling (R3, ADR-0076)', () => {
  const LOOKUP = {
    name: 'lookup_price',
    description: 'Looks up a price.',
    parameters: {
      type: 'object' as const,
      properties: { product: { type: 'string' as const, maxLength: 100 } },
      required: ['product'],
    },
  };

  it('sends the tools as functions, and earlier calls and results as chat messages', () => {
    const body = deepSeekRequestOf(
      call({
        tools: [LOOKUP],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Price?' }] },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_call',
                call: { id: 'c1', name: 'lookup_price', arguments: { product: 'combo' } },
              },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', callId: 'c1', name: 'lookup_price', result: { price: 25 } },
            ],
          },
        ],
      }),
    );
    expect(body?.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'lookup_price',
          description: 'Looks up a price.',
          parameters: {
            type: 'object',
            properties: { product: { type: 'string', maxLength: 100 } },
            required: ['product'],
            additionalProperties: false,
          },
        },
      },
    ]);
    expect(body?.tool_choice).toBe('auto');
    expect(body?.messages).toEqual([
      { role: 'user', content: 'Price?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'lookup_price', arguments: '{"product":"combo"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"price":25}' },
    ]);
  });

  it('reads tool calls, and refuses ones it cannot read', () => {
    const called = (calls: unknown) => ({
      id: 'ds-2',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '', tool_calls: calls },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    expect(
      outcomeOfDeepSeekResponse(
        called([
          {
            id: 'call_0',
            type: 'function',
            function: { name: 'lookup_price', arguments: '{"product":"combo"}' },
          },
        ]),
        false,
      ),
    ).toEqual({
      status: 'success',
      output: {
        toolCalls: [{ id: 'call_0', name: 'lookup_price', arguments: { product: 'combo' } }],
      },
      usage: { inputTokens: 100, outputTokens: 20 },
      finishReason: 'tool_use',
      providerRequestId: 'ds-2',
    });
    for (const bad of [
      [],
      [{ id: 'c', type: 'function', function: { name: 'x', arguments: 'not json' } }],
      [{ id: 'c', type: 'function', function: { name: 'x', arguments: '[1]' } }],
      [{ id: 'bad id!', type: 'function', function: { name: 'x', arguments: '{}' } }],
    ]) {
      expect(outcomeOfDeepSeekResponse(called(bad), false)).toEqual({
        status: 'error',
        kind: 'invalid_response',
      });
    }
  });

  it('offers function calling on the chat model only', () => {
    expect(DEEPSEEK_MODELS.map((m) => [m.modelId, m.toolUse])).toEqual([
      ['deepseek-chat', true],
      ['deepseek-reasoner', false],
    ]);
  });
});

describe('DeepSeek streaming (R4, ADR-0077)', () => {
  const sse = (lines: readonly string[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of lines) controller.enqueue(new TextEncoder().encode(line));
          controller.close();
        },
      }),
    );
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const delta = (content: string, extra: Record<string, unknown> = {}) =>
    data({
      id: 'ds-9',
      choices: [{ index: 0, delta: { content, ...extra }, finish_reason: null }],
    });
  const read = async (events: AsyncIterable<unknown>) => {
    const all: unknown[] = [];
    for await (const e of events) all.push(e);
    return all;
  };
  const streamOf = (reply: () => Response) => {
    const net = network(reply);
    const adapter = createDeepSeekAdapter({
      credentials: resolver().credentials,
      fetch: net.fetchFn,
      now: () => T0,
    });
    if (adapter.stream === undefined) throw new Error('no stream');
    return { net, stream: adapter.stream.bind(adapter) };
  };

  it('streams the answer, never the reasoning, and reads the usage at the end', async () => {
    const { net, stream } = streamOf(() =>
      sse([
        ': keep-alive\n\n',
        delta('', { reasoning_content: 'hidden thoughts' }),
        delta('Hello '),
        delta('there.'),
        data({ id: 'ds-9', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        data({
          id: 'ds-9',
          choices: [],
          usage: { prompt_tokens: 1_000, completion_tokens: 200, prompt_cache_hit_tokens: 600 },
        }),
        'data: [DONE]\n\n',
      ]),
    );
    const all = await read(stream(call()));
    expect(all).toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'there.' },
      {
        type: 'end',
        outcome: {
          status: 'success',
          output: { text: 'Hello there.' },
          usage: { inputTokens: 1_000, outputTokens: 200, cachedInputTokens: 600 },
          finishReason: 'stop',
          providerRequestId: 'ds-9',
        },
      },
    ]);
    expect(JSON.stringify(all)).not.toContain('hidden');
    expect(JSON.parse(String(net.sent[0]?.init?.body))).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('ends with a classified error, and streams only text', async () => {
    const cases: [() => Response, string][] = [
      [() => new Response('{"error":{"message":"busy"}}', { status: 503 }), 'unavailable'],
      [() => sse([delta('No usage '), 'data: [DONE]\n\n']), 'invalid_response'],
      [
        () => sse([delta('', { tool_calls: [{ index: 0, id: 'c1' }] }), 'data: [DONE]\n\n']),
        'invalid_response',
      ],
      [
        () =>
          sse([
            data({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }] }),
            data({ id: 'x', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
          ]),
        'content_policy',
      ],
    ];
    for (const [reply, kind] of cases) {
      const all = await read(streamOf(reply).stream(call()));
      expect(all.at(-1)).toMatchObject({ type: 'end', outcome: { status: 'error', kind } });
      expect(JSON.stringify(all)).not.toContain('busy');
    }
    const { net, stream } = streamOf(() => sse([]));
    expect(await read(stream(call({ structuredOutput: true })))).toEqual([
      { type: 'end', outcome: { status: 'error', kind: 'invalid_request' } },
    ]);
    expect(net.sent).toHaveLength(0);
  });

  it('streams on the chat model only', () => {
    expect(DEEPSEEK_MODELS.map((m) => [m.modelId, m.streaming])).toEqual([
      ['deepseek-chat', true],
      ['deepseek-reasoner', false],
    ]);
  });
});
