import {
  createModelPolicyCatalogue,
  createProviderRegistry,
  creditsFor,
  costMicroUsd,
  CREDIT_RATE,
  type ProviderCall,
} from '@melonoffice/ai-gateway';
import { describe, expect, it } from 'vitest';
import {
  createVertexAIAdapter,
  errorKindOfStatus,
  METADATA_TOKEN_URL,
  outcomeOfVertexResponse,
  toVertexSchema,
  vertexRequestOf,
} from './adapter.js';
import { GEMINI_2_5_FLASH_LITE_MODEL, VERTEX_AI_MODELS, VERTEX_AI_PROVIDER } from './catalogue.js';

const T0 = new Date('2026-09-27T12:00:00.000Z');
/** Credential-shaped test values, built at run time so secret scanners do not flag the source. */
const fake = (...parts: string[]) => parts.join('');
const TOKEN = fake('ya29', '.test-only-access-value');

const call = (overrides: Partial<ProviderCall> = {}): ProviderCall => ({
  requestId: 'assist_abc',
  idempotencyKey: 'k',
  model: { id: 'gemini-2.5-flash-lite', version: 'stable' },
  capability: 'text_generation',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'Policy.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Data.' }] },
  ],
  outputModality: 'text',
  maxOutputTokens: 500,
  structuredOutput: true,
  outputSchema: {
    type: 'object',
    properties: { reply: { type: 'string', maxLength: 10 } },
    required: ['reply'],
  },
  credential: VERTEX_AI_PROVIDER.credential,
  deadline: new Date(T0.getTime() + 5_000),
  ...overrides,
});

const answer = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount: 200, totalTokenCount: 1_200 },
  responseId: 'resp-1',
  ...extra,
});

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fetch that answers the metadata server, then Vertex with `vertex`. */
function network(vertex: () => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init });
    if (url === METADATA_TOKEN_URL) {
      return Response.json({ access_token: TOKEN, expires_in: 3600, token_type: 'Bearer' });
    }
    return vertex();
  }) as typeof fetch;
  return { sent, fetchFn };
}

const adapterWith = (fetchFn: typeof fetch) =>
  createVertexAIAdapter({
    projectId: 'melonoffice-test',
    location: 'us-central1',
    fetch: fetchFn,
    now: () => T0,
  });

describe('Vertex AI adapter (ADR-0038)', () => {
  it('calls generateContent on the official regional endpoint with the service token', async () => {
    const { sent, fetchFn } = network(() => Response.json(answer('{"reply":"Hola"}')));
    const outcome = await adapterWith(fetchFn).generate(call());
    expect(outcome).toEqual({
      status: 'success',
      output: { structured: { reply: 'Hola' } },
      usage: { inputTokens: 1_000, outputTokens: 200 },
      finishReason: 'stop',
      providerRequestId: 'resp-1',
    });
    expect(sent.map((s) => s.url)).toEqual([
      METADATA_TOKEN_URL,
      'https://us-central1-aiplatform.googleapis.com/v1/projects/melonoffice-test/locations/us-central1/publishers/google/models/gemini-2.5-flash-lite:generateContent',
    ]);
    expect(sent[0]?.init?.headers).toEqual({ 'metadata-flavor': 'Google' });
    const request = sent[1]?.init;
    expect(request?.method).toBe('POST');
    expect((request?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    // The policy is the system instruction, apart from the data; nothing else is sent.
    expect(body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Data.' }] }],
      systemInstruction: { parts: [{ text: 'Policy.' }] },
      generationConfig: {
        candidateCount: 1,
        maxOutputTokens: 500,
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { reply: { type: 'STRING', maxLength: 10 } },
          propertyOrdering: ['reply'],
          required: ['reply'],
        },
      },
    });
  });

  it('keeps the token for its lifetime and never puts it in an outcome', async () => {
    const { sent, fetchFn } = network(() => Response.json(answer('{"reply":"x"}')));
    const adapter = adapterWith(fetchFn);
    const outcomes = [await adapter.generate(call()), await adapter.generate(call())];
    expect(sent.filter((s) => s.url === METADATA_TOKEN_URL)).toHaveLength(1);
    expect(JSON.stringify(outcomes)).not.toContain(TOKEN);
  });

  it('classifies HTTP errors without passing on the provider message', async () => {
    for (const [status, kind] of [
      [400, 'invalid_request'],
      [401, 'authentication'],
      [403, 'authentication'],
      [404, 'invalid_request'],
      [408, 'timeout'],
      [429, 'rate_limited'],
      [500, 'server_error'],
      [503, 'unavailable'],
    ] as const) {
      expect(errorKindOfStatus(status)).toBe(kind);
      const { fetchFn } = network(() =>
        Response.json({ error: { message: `secret detail ${TOKEN}` } }, { status }),
      );
      const outcome = await adapterWith(fetchFn).generate(call());
      expect(outcome).toEqual({ status: 'error', kind, httpStatus: status });
    }
  });

  it('turns a network failure, a timeout and a failed token into errors, never a throw', async () => {
    const down = network(() => {
      throw new TypeError('fetch failed');
    });
    expect(await adapterWith(down.fetchFn).generate(call())).toEqual({
      status: 'error',
      kind: 'network',
    });
    // Past its deadline, nothing is sent.
    const late = network(() => Response.json(answer('{}')));
    expect(
      await adapterWith(late.fetchFn).generate(call({ deadline: new Date(T0.getTime() - 1) })),
    ).toEqual({ status: 'error', kind: 'timeout' });
    expect(late.sent).toHaveLength(0);
    const hanging = createVertexAIAdapter({
      projectId: 'melonoffice-test',
      location: 'us-central1',
      now: () => new Date(),
      fetch: ((url: string, init?: RequestInit) =>
        url === METADATA_TOKEN_URL
          ? Promise.resolve(Response.json({ access_token: TOKEN, expires_in: 3600 }))
          : new Promise((_, reject) =>
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
            )) as typeof fetch,
    });
    expect(await hanging.generate(call({ deadline: new Date(Date.now() + 30) }))).toEqual({
      status: 'error',
      kind: 'timeout',
    });
    const noToken = createVertexAIAdapter({
      projectId: 'melonoffice-test',
      location: 'us-central1',
      now: () => T0,
      fetch: (async () => new Response('', { status: 500 })) as typeof fetch,
    });
    expect(await noToken.generate(call())).toEqual({ status: 'error', kind: 'authentication' });
  });

  it('refuses what it cannot send: media, another credential, another capability', async () => {
    const { sent, fetchFn } = network(() => Response.json(answer('{}')));
    const adapter = adapterWith(fetchFn);
    const cases: Partial<ProviderCall>[] = [
      {
        messages: [{ role: 'user', content: [{ type: 'image', ref: { type: 'file', id: 'f1' } }] }],
      },
      { messages: [{ role: 'system', content: [{ type: 'text', text: 'Only policy.' }] }] },
      { credential: { provider: 'openai', scopes: [] } },
      { capability: 'embeddings' },
      { outputModality: 'audio' },
      { model: { id: '../../other', version: '1' } },
    ];
    for (const overrides of cases) {
      const outcome = await adapter.generate(call(overrides));
      expect(outcome.status).toBe('error');
    }
    expect(sent).toHaveLength(0);
  });

  it('reads malformed, blocked, cut and unaccounted answers safely', () => {
    expect(outcomeOfVertexResponse('nope', true)).toMatchObject({ kind: 'invalid_response' });
    expect(outcomeOfVertexResponse({ candidates: [] }, true)).toMatchObject({
      kind: 'invalid_response',
    });
    // No usage: it could not be charged, so it is not passed on.
    const unaccounted: Record<string, unknown> = { ...answer('{}') };
    delete unaccounted.usageMetadata;
    expect(outcomeOfVertexResponse(unaccounted, true)).toMatchObject({
      kind: 'invalid_response',
    });
    expect(
      outcomeOfVertexResponse(answer('{}', { promptFeedback: { blockReason: 'SAFETY' } }), true),
    ).toMatchObject({ kind: 'content_policy' });
    const blocked = answer('');
    (blocked.candidates[0] as { finishReason: string }).finishReason = 'SAFETY';
    expect(outcomeOfVertexResponse(blocked, true)).toMatchObject({ kind: 'content_policy' });
    const cut = answer('{"reply":"Ho');
    (cut.candidates[0] as { finishReason: string }).finishReason = 'MAX_TOKENS';
    // Cut JSON stays text: the caller refuses it.
    expect(outcomeOfVertexResponse(cut, true)).toMatchObject({
      status: 'success',
      finishReason: 'length',
      output: { text: '{"reply":"Ho' },
    });
  });

  it('counts reasoning as output and leaves thoughts out of the answer', () => {
    const body = answer('', {
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 },
      candidates: [
        {
          content: { parts: [{ text: 'thinking', thought: true }, { text: '{"a":1}' }] },
          finishReason: 'STOP',
        },
      ],
    });
    expect(outcomeOfVertexResponse(body, true)).toMatchObject({
      output: { structured: { a: 1 } },
      usage: { inputTokens: 10, outputTokens: 12 },
    });
  });

  it('maps nested schemas, enums and bounds', () => {
    expect(
      toVertexSchema({
        type: 'object',
        properties: {
          intent: { type: 'string', enum: ['a', 'b'] },
          list: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          score: { type: 'number', minimum: 0, maximum: 1, nullable: true },
          flag: { type: 'boolean' },
        },
      }),
    ).toEqual({
      type: 'OBJECT',
      properties: {
        intent: { type: 'STRING', format: 'enum', enum: ['a', 'b'] },
        list: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 3 },
        score: { type: 'NUMBER', nullable: true, minimum: 0, maximum: 1 },
        flag: { type: 'BOOLEAN' },
      },
      propertyOrdering: ['intent', 'list', 'score', 'flag'],
    });
    expect(vertexRequestOf(call({ structuredOutput: false }))?.generationConfig).not.toHaveProperty(
      'responseSchema',
    );
  });

  it('refuses a configuration that is not a project id and a location', () => {
    expect(() => createVertexAIAdapter({ projectId: 'x', location: 'us-central1' })).toThrow();
    expect(() =>
      createVertexAIAdapter({ projectId: 'melonoffice', location: 'evil.com/x' }),
    ).toThrow();
  });
});

describe('Vertex AI catalogue (ADR-0038)', () => {
  const adapter = createVertexAIAdapter({ projectId: 'melonoffice', location: 'us-central1' });

  it('registers as an official provider with one DEV model and a known price', () => {
    const registry = createProviderRegistry({
      providers: [VERTEX_AI_PROVIDER],
      models: VERTEX_AI_MODELS,
      adapters: [adapter],
    });
    expect(registry.models().map((m) => `${m.provider.id}/${m.model.modelId}`)).toEqual([
      'google-vertex-ai/gemini-2.5-flash-lite',
    ]);
    expect(VERTEX_AI_PROVIDER.environments).toEqual(['dev']);
    expect(GEMINI_2_5_FLASH_LITE_MODEL.environments).toEqual(['dev']);
    // The credential is a reference to the service identity's scope, never a value.
    expect(VERTEX_AI_PROVIDER.credential).toEqual({
      provider: 'google_cloud',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  });

  it('prices a call at the published rate and charges whole credits, rounded up', () => {
    const { pricing } = GEMINI_2_5_FLASH_LITE_MODEL;
    // US$0.10 and US$0.40 per million tokens.
    expect(costMicroUsd(pricing, { inputTokens: 1_000_000, outputTokens: 0 })).toBe(100_000);
    expect(costMicroUsd(pricing, { inputTokens: 0, outputTokens: 1_000_000 })).toBe(400_000);
    // A typical assisted call: 3,500 in and 1,200 out is US$0.00083, so 1 credit (US$0.01).
    const typical = costMicroUsd(pricing, { inputTokens: 3_500, outputTokens: 1_200 });
    expect(typical).toBe(830);
    expect(creditsFor(typical ?? 0, CREDIT_RATE)).toBe(1);
    // Never less than the cost: one micro-dollar over a credit is two.
    expect(creditsFor(10_001, CREDIT_RATE)).toBe(2);
    expect(creditsFor(10_000, CREDIT_RATE)).toBe(1);
    expect(creditsFor(1, CREDIT_RATE)).toBe(1);
  });

  it('is not usable with the default policy alone', () => {
    // The default policy allows data up to internal only; nothing here changes it.
    expect(createModelPolicyCatalogue([]).resolve(undefined)?.maxSensitivity).toBe('internal');
  });
});
