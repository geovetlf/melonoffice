import type {
  AIMessage,
  AIOutputSchema,
  AIToolCall,
  FinishReason,
  ProviderAdapter,
  ProviderCall,
  ProviderErrorKind,
  ProviderOutcome,
  ProviderStreamEvent,
} from '@melonoffice/ai-gateway';
import {
  readServerSentEvents,
  ServerSentEventsTooLarge,
  STORED_DOCUMENT_KEY,
} from '@melonoffice/ai-gateway';
import type { ToolSchema } from '@melonoffice/domain';
import { VERTEX_AI_PROVIDER } from './catalogue.js';

/**
 * The Vertex AI adapter (ADR-0038): translates the gateway's `ProviderCall` to Vertex AI's
 * `generateContent` REST API and its answer back, and nothing more. It is the only code that
 * knows Vertex's endpoint, request and response format. No SDK, no key: it authenticates as
 * the service's own identity with a token from the metadata server, like Secret Manager
 * (ADR-0033), and the token never leaves this file.
 *
 * It never throws: every failure is a classified `ProviderOutcome` error, without the provider's
 * message, so the gateway decides on retries alone and nothing the provider says reaches a log,
 * an audit event or a person.
 */
export const VERTEX_ADAPTER_VERSION = '4';

export const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

export interface VertexAIAdapterOptions {
  /** The Google Cloud project that runs the model and is billed for it. */
  readonly projectId: string;
  /** Its Vertex AI location, e.g. `us-central1`. */
  readonly location: string;
  /**
   * The documents bucket (ADR-0078), from configuration: a stored PDF is given to the model as a
   * `gs://` reference into it, which Vertex AI reads with its own service agent (ADR-0079).
   * Absent: a call with a document is refused as `invalid_request`.
   */
  readonly documentsBucket?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION = /^[a-z]+-[a-z]+[0-9]{1,2}$/;
const MODEL = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const RESPONSE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
// Bucket names without dots, as the documents bucket is named (ADR-0078).
const BUCKET = /^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/;
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Larger answers are refused rather than read: no call here asks for anything near it. */
const MAX_RESPONSE_BYTES = 1_000_000;
/** A token is renewed this long before Google says it expires. */
const TOKEN_MARGIN_MS = 60_000;

const error = (kind: ProviderErrorKind, httpStatus?: number): ProviderOutcome =>
  Object.freeze({ status: 'error', kind, ...(httpStatus === undefined ? {} : { httpStatus }) });

/** An HTTP status as Vertex AI answers it, as a gateway error kind. */
export function errorKindOfStatus(status: number): ProviderErrorKind {
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 503) return 'unavailable';
  if (status >= 500) return 'server_error';
  return 'invalid_request';
}

type VertexSchema = Record<string, unknown>;

/** The gateway's closed output schema as Vertex AI's `responseSchema` (an OpenAPI subset). */
export function toVertexSchema(schema: AIOutputSchema): VertexSchema {
  const out: VertexSchema = { type: schema.type.toUpperCase() };
  if (schema.nullable === true) out.nullable = true;
  switch (schema.type) {
    case 'string':
      if (schema.enum !== undefined) {
        out.format = 'enum';
        out.enum = [...schema.enum];
      }
      if (schema.maxLength !== undefined) out.maxLength = schema.maxLength;
      break;
    case 'number':
    case 'integer':
      if (schema.minimum !== undefined) out.minimum = schema.minimum;
      if (schema.maximum !== undefined) out.maximum = schema.maximum;
      break;
    case 'boolean':
      break;
    case 'array':
      out.items = toVertexSchema(schema.items);
      if (schema.minItems !== undefined) out.minItems = schema.minItems;
      if (schema.maxItems !== undefined) out.maxItems = schema.maxItems;
      break;
    case 'object': {
      const names = Object.keys(schema.properties);
      out.properties = Object.fromEntries(
        names.map((name) => [name, toVertexSchema(schema.properties[name] as AIOutputSchema)]),
      );
      out.propertyOrdering = names;
      if (schema.required !== undefined) out.required = [...schema.required];
      break;
    }
  }
  return out;
}

/** A tool's input schema as a Vertex AI function declaration's `parameters` (R3, ADR-0076). */
export function toVertexParameters(schema: ToolSchema): VertexSchema {
  const out: VertexSchema = { type: schema.type.toUpperCase() };
  switch (schema.type) {
    case 'string':
      if (schema.enum !== undefined) {
        out.format = 'enum';
        out.enum = [...schema.enum];
      }
      out.maxLength = schema.maxLength;
      if (schema.minLength !== undefined) out.minLength = schema.minLength;
      break;
    case 'number':
    case 'integer':
      if (schema.minimum !== undefined) out.minimum = schema.minimum;
      if (schema.maximum !== undefined) out.maximum = schema.maximum;
      break;
    case 'boolean':
      break;
    case 'array':
      out.items = toVertexParameters(schema.items);
      out.maxItems = schema.maxItems;
      break;
    case 'object': {
      const names = Object.keys(schema.properties);
      out.properties = Object.fromEntries(
        names.map((name) => [name, toVertexParameters(schema.properties[name] as ToolSchema)]),
      );
      if (schema.required !== undefined) out.required = [...schema.required];
      break;
    }
  }
  return out;
}

type VertexPart = Record<string, unknown>;

/** A function's response must be an object: anything else is wrapped as `{ result }`. */
const responseObject = (result: unknown): Record<string, unknown> =>
  typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { result };

/**
 * The request body, or undefined when the call asks for something this adapter cannot send. A
 * stored document is sent only with the documents bucket, only from a `user` message, and only
 * under a key of the documents' own shape (ADR-0079); the gateway has already checked that it is
 * the tenant's. Other media is never sent.
 */
export function vertexRequestOf(
  call: ProviderCall,
  options: { readonly documentsBucket?: string } = {},
): Record<string, unknown> | undefined {
  const { documentsBucket } = options;
  const system: { text: string }[] = [];
  const contents: { role: 'user' | 'model'; parts: VertexPart[] }[] = [];
  for (const message of call.messages as readonly AIMessage[]) {
    const parts: VertexPart[] = [];
    for (const part of message.content) {
      if (part.type === 'text') parts.push({ text: part.text });
      else if (part.type === 'tool_call') {
        parts.push({ functionCall: { name: part.call.name, args: part.call.arguments } });
      } else if (part.type === 'tool_result') {
        parts.push({
          functionResponse: { name: part.name, response: responseObject(part.result) },
        });
      } else if (part.type === 'document') {
        if (
          documentsBucket === undefined ||
          message.role !== 'user' ||
          part.mimeType !== 'application/pdf' ||
          part.ref.type !== 'stored_document' ||
          !STORED_DOCUMENT_KEY.test(part.ref.id)
        ) {
          return undefined;
        }
        parts.push({
          fileData: {
            mimeType: 'application/pdf',
            fileUri: `gs://${documentsBucket}/${part.ref.id}`,
          },
        });
      }
      // Other media is not sent in this version (ADR-0038).
      else return undefined;
    }
    if (message.role === 'system') {
      if (parts.some((p) => typeof p.text !== 'string')) return undefined;
      system.push(...(parts as { text: string }[]));
    } else contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  if (contents.length === 0) return undefined;
  const tools = call.tools ?? [];
  return {
    contents,
    ...(system.length === 0 ? {} : { systemInstruction: { parts: system } }),
    ...(tools.length === 0
      ? {}
      : {
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: toVertexParameters(t.parameters),
              })),
            },
          ],
          // The model decides whether to call; it never answers with a function it was not given.
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        }),
    generationConfig: {
      candidateCount: 1,
      maxOutputTokens: call.maxOutputTokens,
      // Low, so the same conversation gives steady answers.
      temperature: 0.2,
      // No reasoning: these calls do not need it, and it would only add cost.
      thinkingConfig: { thinkingBudget: 0 },
      ...(call.structuredOutput ? { responseMimeType: 'application/json' } : {}),
      ...(call.structuredOutput && call.outputSchema !== undefined
        ? { responseSchema: toVertexSchema(call.outputSchema) }
        : {}),
    },
  };
}

const FINISH: Readonly<Record<string, FinishReason>> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
};

/** Finish reasons that mean the answer was withheld or cut for its content. */
const BLOCKED = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Vertex AI's answer as a gateway outcome; anything unexpected is an invalid response. */
export function outcomeOfVertexResponse(body: unknown, structured: boolean): ProviderOutcome {
  if (!isRecord(body)) return error('invalid_response');
  const feedback = body.promptFeedback;
  if (isRecord(feedback) && typeof feedback.blockReason === 'string') {
    return error('content_policy');
  }
  const usage = body.usageMetadata;
  if (!isRecord(usage)) return error('invalid_response');
  const inputTokens = count(usage.promptTokenCount);
  const answerTokens = count(usage.candidatesTokenCount ?? 0);
  const thoughtTokens = count(usage.thoughtsTokenCount ?? 0);
  // Without usage the call cannot be charged: it is not passed on.
  if (inputTokens === undefined || answerTokens === undefined || thoughtTokens === undefined) {
    return error('invalid_response');
  }
  const candidates = body.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return error('invalid_response');
  const [candidate] = candidates as unknown[];
  if (!isRecord(candidate)) return error('invalid_response');
  const reason = candidate.finishReason;
  if (typeof reason === 'string' && BLOCKED.has(reason)) return error('content_policy');
  const finishReason = typeof reason === 'string' ? FINISH[reason] : undefined;
  if (finishReason === undefined) return error('invalid_response');
  const content = candidate.content;
  const parts = isRecord(content) && Array.isArray(content.parts) ? content.parts : undefined;
  if (parts === undefined) return error('invalid_response');
  // Reasoning is never part of the answer.
  const answer = parts.filter(
    (p): p is Record<string, unknown> => isRecord(p) && p.thought !== true,
  );
  const text = answer.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
  // Calls the model asked for (R3, ADR-0076). The gateway checks them against the tools offered.
  const toolCalls: AIToolCall[] = [];
  for (const part of answer) {
    if (part.functionCall === undefined) continue;
    const fn = part.functionCall;
    if (!isRecord(fn) || typeof fn.name !== 'string') return error('invalid_response');
    const args = fn.args ?? {};
    if (!isRecord(args)) return error('invalid_response');
    const id =
      typeof fn.id === 'string' && CALL_ID.test(fn.id) ? fn.id : `call_${toolCalls.length + 1}`;
    toolCalls.push(Object.freeze({ id, name: fn.name, arguments: args }));
  }
  if (toolCalls.length > 0) {
    return Object.freeze({
      status: 'success',
      output: Object.freeze({
        ...(text.length === 0 ? {} : { text }),
        toolCalls: Object.freeze(toolCalls),
      }),
      usage: Object.freeze({ inputTokens, outputTokens: answerTokens + thoughtTokens }),
      finishReason: 'tool_use',
      ...(typeof body.responseId === 'string' && RESPONSE_ID.test(body.responseId)
        ? { providerRequestId: body.responseId }
        : {}),
    });
  }
  let output: { text?: string; structured?: unknown } = { text };
  if (structured) {
    try {
      output = { structured: JSON.parse(text) as unknown };
    } catch {
      // Left as text: the caller checks it, and refuses what it cannot read.
    }
  }
  const responseId = body.responseId;
  return Object.freeze({
    status: 'success',
    output: Object.freeze(output),
    // Reasoning is billed as output: counted, so a call is never under-charged.
    usage: Object.freeze({ inputTokens, outputTokens: answerTokens + thoughtTokens }),
    finishReason,
    ...(typeof responseId === 'string' && RESPONSE_ID.test(responseId)
      ? { providerRequestId: responseId }
      : {}),
  });
}

/**
 * A streamed answer, chunk by chunk (R4, ADR-0077). Each chunk is a `generateContent` answer
 * holding the next piece of text; the last carries the finish reason and the usage. At the end
 * they read as one answer, checked by `outcomeOfVertexResponse` like any other.
 */
export class VertexStreamChunks {
  #text = '';
  #finishReason: unknown;
  #usage: unknown;
  #responseId: unknown;
  #failed: ProviderOutcome | undefined;

  /** Reads one event's data: the text it adds, or `undefined` when the stream cannot go on. */
  add(data: string): string | undefined {
    if (this.#failed !== undefined) return undefined;
    let chunk: unknown;
    try {
      chunk = JSON.parse(data) as unknown;
    } catch {
      chunk = undefined;
    }
    if (!isRecord(chunk)) return this.#fail(error('invalid_response'));
    const feedback = chunk.promptFeedback;
    if (isRecord(feedback) && typeof feedback.blockReason === 'string') {
      return this.#fail(error('content_policy'));
    }
    if (chunk.usageMetadata !== undefined) this.#usage = chunk.usageMetadata;
    if (chunk.responseId !== undefined) this.#responseId = chunk.responseId;
    const candidates = chunk.candidates;
    if (candidates === undefined) return '';
    if (!Array.isArray(candidates)) return this.#fail(error('invalid_response'));
    const [candidate] = candidates as unknown[];
    if (candidate === undefined) return '';
    if (!isRecord(candidate)) return this.#fail(error('invalid_response'));
    if (candidate.finishReason !== undefined) this.#finishReason = candidate.finishReason;
    const content = candidate.content;
    if (content === undefined) return '';
    const parts = isRecord(content) && Array.isArray(content.parts) ? content.parts : undefined;
    if (parts === undefined) return this.#fail(error('invalid_response'));
    let piece = '';
    for (const part of parts as unknown[]) {
      if (!isRecord(part)) return this.#fail(error('invalid_response'));
      // Reasoning is never part of the answer; a call was never offered in a stream.
      if (part.thought === true) continue;
      if (part.functionCall !== undefined) return this.#fail(error('invalid_response'));
      if (typeof part.text === 'string') piece += part.text;
    }
    this.#text += piece;
    return piece;
  }

  /** The whole answer, as `generate` would have read it. */
  outcome(): ProviderOutcome {
    if (this.#failed !== undefined) return this.#failed;
    // A stream cut for its content may end without usage: it is still a content refusal.
    if (typeof this.#finishReason === 'string' && BLOCKED.has(this.#finishReason)) {
      return error('content_policy');
    }
    return outcomeOfVertexResponse(
      {
        candidates: [
          { content: { parts: [{ text: this.#text }] }, finishReason: this.#finishReason },
        ],
        usageMetadata: this.#usage,
        ...(this.#responseId === undefined ? {} : { responseId: this.#responseId }),
      },
      false,
    );
  }

  #fail(outcome: ProviderOutcome): undefined {
    this.#failed = outcome;
    return undefined;
  }
}

/**
 * Creates the adapter. The project and location come from configuration (Terraform), never from
 * a request; the model id comes from the registry.
 */
export function createVertexAIAdapter(options: VertexAIAdapterOptions): ProviderAdapter {
  const { projectId, location, documentsBucket } = options;
  if (!PROJECT.test(projectId)) throw new Error('vertex_ai.projectId');
  if (!LOCATION.test(location)) throw new Error('vertex_ai.location');
  if (
    documentsBucket !== undefined &&
    (!BUCKET.test(documentsBucket) || documentsBucket.startsWith('goog'))
  ) {
    throw new Error('vertex_ai.documentsBucket');
  }
  const requestOptions = documentsBucket === undefined ? {} : { documentsBucket };
  const call = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models`;
  let token: { readonly value: string; readonly until: number } | undefined;

  async function accessToken(signal: AbortSignal): Promise<string | undefined> {
    if (token !== undefined && now().getTime() < token.until) return token.value;
    try {
      const answer = await call(METADATA_TOKEN_URL, {
        headers: { 'metadata-flavor': 'Google' },
        signal,
      });
      if (!answer.ok) return undefined;
      const body = (await answer.json()) as { access_token?: unknown; expires_in?: unknown };
      if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
        return undefined;
      }
      const seconds = typeof body.expires_in === 'number' ? body.expires_in : 0;
      token = {
        value: body.access_token,
        until: now().getTime() + seconds * 1000 - TOKEN_MARGIN_MS,
      };
      return token.value;
    } catch {
      return undefined;
    }
  }

  /**
   * Checks a call, gets a token and sends it to `method`: the provider's answer when it accepted
   * the call, or the classified error.
   */
  async function open(
    request: ProviderCall,
    method: string,
  ): Promise<{ readonly answer: Response; readonly signal: AbortSignal } | ProviderOutcome> {
    // Only this provider's own credential reference: the service's identity.
    if (request.credential.provider !== VERTEX_AI_PROVIDER.credential.provider) {
      return error('authentication');
    }
    if (request.capability !== 'text_generation' || request.outputModality !== 'text') {
      return error('invalid_request');
    }
    if (!MODEL.test(request.model.id)) return error('invalid_request');
    const body = vertexRequestOf(request, requestOptions);
    if (body === undefined) return error('invalid_request');
    const remaining = request.deadline.getTime() - now().getTime();
    if (remaining <= 0) return error('timeout');
    const signal = AbortSignal.timeout(remaining);

    const bearer = await accessToken(signal);
    if (bearer === undefined) {
      return signal.aborted ? error('timeout') : error('authentication');
    }
    let answer: Response;
    try {
      answer = await call(`${endpoint}/${request.model.id}:${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      return signal.aborted ? error('timeout') : error('network');
    }
    if (!answer.ok) {
      // A refused token is dropped, so the next call asks for a new one.
      if (answer.status === 401) token = undefined;
      return error(errorKindOfStatus(answer.status), answer.status);
    }
    return { answer, signal };
  }

  return Object.freeze({
    providerId: VERTEX_AI_PROVIDER.id,
    adapterVersion: VERTEX_ADAPTER_VERSION,
    capabilities: () => VERTEX_AI_PROVIDER.capabilities,
    // No probe: a failed call says more, and costs nothing.
    health: async () => 'available' as const,

    async generate(request: ProviderCall): Promise<ProviderOutcome> {
      try {
        const opened = await open(request, 'generateContent');
        if (!('answer' in opened)) return opened;
        const { answer, signal } = opened;
        let raw: string;
        try {
          raw = await answer.text();
        } catch {
          return signal.aborted ? error('timeout') : error('network');
        }
        if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) return error('invalid_response');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          return error('invalid_response');
        }
        return outcomeOfVertexResponse(parsed, request.structuredOutput);
      } catch {
        return error('invalid_response');
      }
    },

    // Streaming (R4, ADR-0077): `streamGenerateContent` as server-sent events, text only.
    async *stream(request: ProviderCall): AsyncGenerator<ProviderStreamEvent> {
      const end = (outcome: ProviderOutcome): ProviderStreamEvent =>
        Object.freeze({ type: 'end', outcome });
      if (request.structuredOutput || (request.tools?.length ?? 0) > 0) {
        yield end(error('invalid_request'));
        return;
      }
      let opened: Awaited<ReturnType<typeof open>>;
      try {
        opened = await open(request, 'streamGenerateContent?alt=sse');
      } catch {
        opened = error('invalid_response');
      }
      if (!('answer' in opened)) {
        yield end(opened);
        return;
      }
      const { answer, signal } = opened;
      if (answer.body === null) {
        yield end(error('invalid_response'));
        return;
      }
      const chunks = new VertexStreamChunks();
      try {
        for await (const data of readServerSentEvents(answer.body, MAX_RESPONSE_BYTES)) {
          const piece = chunks.add(data);
          if (piece === undefined) break;
          if (piece.length > 0) yield Object.freeze({ type: 'text', text: piece });
        }
      } catch (thrown) {
        yield end(
          thrown instanceof ServerSentEventsTooLarge
            ? error('invalid_response')
            : signal.aborted
              ? error('timeout')
              : error('network'),
        );
        return;
      }
      yield end(chunks.outcome());
    },
  });
}
