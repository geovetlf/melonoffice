import type {
  AIMessage,
  AIToolCall,
  CredentialResolver,
  FinishReason,
  ProviderAdapter,
  ProviderCall,
  ProviderCredential,
  ProviderErrorKind,
  ProviderOutcome,
  ProviderStreamEvent,
} from '@melonoffice/ai-gateway';
import {
  readServerSentEvents,
  retryAfterMsOf,
  ServerSentEventsTooLarge,
} from '@melonoffice/ai-gateway';
import type { ToolSchema } from '@melonoffice/domain';
import { NVIDIA_API_MODEL_NAMES, NVIDIA_PROVIDER, THINKING_SWITCH_MODELS } from './catalogue.js';

/**
 * The NVIDIA adapter (ADR-0080): translates the gateway's `ProviderCall` to NVIDIA's official
 * OpenAI-compatible chat completions API and its answer back, and nothing more. It is the only
 * code that knows NVIDIA's endpoint, request and response format. No SDK.
 *
 * The same API serves NVIDIA's hosted endpoints (`https://integrate.api.nvidia.com/v1`) and a
 * self-hosted NIM (`/v1/chat/completions` on its own address), so a self-hosted NIM later is a
 * different `baseUrl`, not a different adapter. Only the hosted API is used today.
 *
 * Its API key comes from a `CredentialResolver` (Secret Manager on the server), is kept in memory
 * for a short while, and never leaves this file. It never throws: every failure is a classified
 * `ProviderOutcome` error without NVIDIA's message, so nothing NVIDIA says reaches a log, an audit
 * event or a person. A 429 carries NVIDIA's `Retry-After`, which the gateway honours.
 */
export const NVIDIA_ADAPTER_VERSION = '1';
export const NVIDIA_HOSTED_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export interface NvidiaAdapterOptions {
  readonly credentials: CredentialResolver;
  /** The API's base address. Absent: NVIDIA's hosted API. Must be `https://`. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /** How long a resolved key is kept before it is read again. */
  readonly credentialTtlMs?: number;
}

const RESPONSE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE_URL = /^https:\/\/[a-z0-9.-]{1,253}(:\d{1,5})?(\/[A-Za-z0-9._~/-]{0,200})?$/;
const MAX_RESPONSE_BYTES = 1_000_000;
/** Only this much of an error body is read, to tell a context overflow from other refusals. */
const MAX_ERROR_BYTES = 4_096;

const error = (
  kind: ProviderErrorKind,
  httpStatus?: number,
  retryAfterMs?: number,
): ProviderOutcome =>
  Object.freeze({
    status: 'error',
    kind,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

/**
 * An HTTP status as NVIDIA answers it, as a gateway error kind.
 *
 * - 401 and 403: the key is wrong or not allowed this model.
 * - 402: the account's trial credits are spent. It is the account's problem, not a passing one:
 *   not retried, but another provider may answer.
 * - 404: the model is not served (retired or never offered): another model may answer.
 * - 429: too many requests; retried after NVIDIA's `Retry-After`.
 */
export function errorKindOfStatus(status: number): ProviderErrorKind {
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 402 || status === 403) return 'authentication';
  if (status === 404 || status === 503) return 'unavailable';
  if (status >= 500) return 'server_error';
  return 'invalid_request';
}

/** A tool's input schema as JSON Schema for a function's `parameters` (R3, ADR-0076). */
export function toJsonSchema(schema: ToolSchema): Record<string, unknown> {
  switch (schema.type) {
    case 'string':
      return {
        type: 'string',
        maxLength: schema.maxLength,
        ...(schema.minLength === undefined ? {} : { minLength: schema.minLength }),
        ...(schema.enum === undefined ? {} : { enum: [...schema.enum] }),
      };
    case 'number':
    case 'integer':
      return {
        type: schema.type,
        ...(schema.minimum === undefined ? {} : { minimum: schema.minimum }),
        ...(schema.maximum === undefined ? {} : { maximum: schema.maximum }),
      };
    case 'boolean':
      return { type: 'boolean' };
    case 'array':
      return { type: 'array', items: toJsonSchema(schema.items), maxItems: schema.maxItems };
    case 'object':
      return {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(schema.properties).map(([name, s]) => [name, toJsonSchema(s)]),
        ),
        ...(schema.required === undefined ? {} : { required: [...schema.required] }),
        additionalProperties: false,
      };
  }
}

type ChatMessage = Record<string, unknown> & { role: string };

/**
 * The request body, or undefined when the call asks for something this adapter does not send:
 * a model outside the closed list, media, or a structured answer (not documented for the hosted
 * endpoint, so never claimed).
 */
export function nvidiaRequestOf(call: ProviderCall): Record<string, unknown> | undefined {
  const model = NVIDIA_API_MODEL_NAMES[call.model.id];
  if (model === undefined || call.structuredOutput || call.outputSchema !== undefined) {
    return undefined;
  }
  const messages: ChatMessage[] = [];
  for (const message of call.messages as readonly AIMessage[]) {
    const texts: string[] = [];
    const calls: Record<string, unknown>[] = [];
    const results: ChatMessage[] = [];
    for (const part of message.content) {
      if (part.type === 'text') texts.push(part.text);
      else if (part.type === 'tool_call') {
        calls.push({
          id: part.call.id,
          type: 'function',
          function: { name: part.call.name, arguments: JSON.stringify(part.call.arguments) },
        });
      } else if (part.type === 'tool_result') {
        // Each result is its own `tool` message, after the call it answers.
        results.push({
          role: 'tool',
          tool_call_id: part.callId,
          content: JSON.stringify(part.result),
        });
      }
      // Media is not sent in this version.
      else return undefined;
    }
    if (calls.length > 0) {
      messages.push({ role: 'assistant', content: texts.join('\n'), tool_calls: calls });
    } else if (texts.length > 0) {
      messages.push({ role: message.role, content: texts.join('\n') });
    }
    messages.push(...results);
  }
  if (!messages.some((m) => m.role === 'user')) return undefined;
  return {
    model,
    messages,
    max_tokens: call.maxOutputTokens,
    temperature: 0.2,
    stream: false,
    ...(THINKING_SWITCH_MODELS.has(call.model.id)
      ? { chat_template_kwargs: { enable_thinking: false } }
      : {}),
    ...(call.tools === undefined || call.tools.length === 0
      ? {}
      : {
          tools: call.tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: toJsonSchema(t.parameters),
            },
          })),
          tool_choice: 'auto',
        }),
  };
}

const FINISH: Readonly<Record<string, FinishReason>> = {
  stop: 'stop',
  length: 'length',
  content_filter: 'content_filter',
  tool_calls: 'tool_use',
};

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * The answer without a reasoning trace some models put before it in `<think>` tags, even with
 * thinking switched off. Undefined when a trace is opened and never closed: there is no answer.
 */
export function withoutReasoning(content: string): string | undefined {
  const start = content.trimStart();
  if (!start.startsWith(THINK_OPEN)) return content;
  const end = start.indexOf(THINK_CLOSE);
  if (end === -1) return undefined;
  return start.slice(end + THINK_CLOSE.length).trimStart();
}

/** NVIDIA's answer as a gateway outcome; anything unexpected is an invalid response. */
export function outcomeOfNvidiaResponse(body: unknown): ProviderOutcome {
  if (!isRecord(body)) return error('invalid_response');
  const usage = body.usage;
  if (!isRecord(usage)) return error('invalid_response');
  const inputTokens = count(usage.prompt_tokens);
  const outputTokens = count(usage.completion_tokens);
  // Without usage the call cannot be accounted for: it is not passed on.
  if (inputTokens === undefined || outputTokens === undefined) return error('invalid_response');
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return error('invalid_response');
  const [choice] = choices as unknown[];
  if (!isRecord(choice)) return error('invalid_response');
  const reason = choice.finish_reason;
  if (reason === 'content_filter') return error('content_policy');
  const finishReason = typeof reason === 'string' ? FINISH[reason] : undefined;
  if (finishReason === undefined) return error('invalid_response');
  const message = choice.message;
  if (!isRecord(message)) return error('invalid_response');
  const id = body.id;
  const usageOf = Object.freeze({ inputTokens, outputTokens });
  const requestId = typeof id === 'string' && RESPONSE_ID.test(id) ? { providerRequestId: id } : {};
  // Calls the model asked for (R3, ADR-0076). The gateway checks them against the tools offered.
  if (finishReason === 'tool_use') {
    const calls = message.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) return error('invalid_response');
    const toolCalls: AIToolCall[] = [];
    for (const call of calls as unknown[]) {
      if (!isRecord(call) || call.type !== 'function' || !isRecord(call.function)) {
        return error('invalid_response');
      }
      const { name, arguments: raw } = call.function;
      if (typeof call.id !== 'string' || !CALL_ID.test(call.id) || typeof name !== 'string') {
        return error('invalid_response');
      }
      let args: unknown;
      try {
        args = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : undefined;
      } catch {
        return error('invalid_response');
      }
      if (!isRecord(args)) return error('invalid_response');
      toolCalls.push(Object.freeze({ id: call.id, name, arguments: args }));
    }
    const text =
      typeof message.content === 'string' ? (withoutReasoning(message.content) ?? '') : '';
    return Object.freeze({
      status: 'success',
      output: Object.freeze({
        ...(text.length === 0 ? {} : { text }),
        toolCalls: Object.freeze(toolCalls),
      }),
      usage: usageOf,
      finishReason,
      ...requestId,
    });
  }
  // Only the answer: `reasoning_content` and a `<think>` trace are never passed on.
  if (typeof message.content !== 'string') return error('invalid_response');
  const text = withoutReasoning(message.content);
  if (text === undefined) return error('invalid_response');
  return Object.freeze({
    status: 'success',
    output: Object.freeze({ text }),
    // Reasoning, when any, is counted within `completion_tokens`: never under-counted.
    usage: usageOf,
    finishReason,
    ...requestId,
  });
}

/**
 * A streamed answer, chunk by chunk (R4, ADR-0077): each chunk holds the next piece in
 * `delta.content`, the finish reason on the last one with choices, and the usage on a chunk of its
 * own after it (`stream_options.include_usage`). A `<think>` trace at the start is held back and
 * dropped, never passed on. At the end they read as one answer, checked by
 * `outcomeOfNvidiaResponse` like any other.
 */
export class NvidiaStreamChunks {
  /** Everything the model said, trace included. */
  #raw = '';
  /** What has gone out: the answer only. */
  #released = 0;
  #finishReason: unknown;
  #usage: unknown;
  #id: unknown;
  #ended = false;
  #failed: ProviderOutcome | undefined;

  /** Reads one event's data: the text it adds, or `undefined` when the stream cannot go on. */
  add(data: string): string | undefined {
    if (this.#failed !== undefined || this.#ended) return undefined;
    if (data === '[DONE]') {
      this.#ended = true;
      return undefined;
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(data) as unknown;
    } catch {
      chunk = undefined;
    }
    if (!isRecord(chunk)) return this.#fail(error('invalid_response'));
    if (chunk.id !== undefined) this.#id = chunk.id;
    if (chunk.usage !== undefined && chunk.usage !== null) this.#usage = chunk.usage;
    const choices = chunk.choices;
    if (choices === undefined) return '';
    if (!Array.isArray(choices)) return this.#fail(error('invalid_response'));
    const [choice] = choices as unknown[];
    if (choice === undefined) return '';
    if (!isRecord(choice)) return this.#fail(error('invalid_response'));
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      this.#finishReason = choice.finish_reason;
    }
    const delta = choice.delta;
    if (delta === undefined || delta === null) return '';
    if (!isRecord(delta)) return this.#fail(error('invalid_response'));
    // A call was never offered in a stream.
    if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
      return this.#fail(error('invalid_response'));
    }
    this.#raw += typeof delta.content === 'string' ? delta.content : '';
    return this.#next();
  }

  /** What of the answer may go out now: nothing while a trace may still be open. */
  #next(): string {
    const start = this.#raw.trimStart();
    // Still could be the start of `<think>`: wait.
    if (start.length < THINK_OPEN.length && THINK_OPEN.startsWith(start)) return '';
    const answer = withoutReasoning(this.#raw);
    if (answer === undefined) return '';
    const out = answer.slice(this.#released);
    this.#released = answer.length;
    return out;
  }

  /** The whole answer, as `generate` would have read it. */
  outcome(): ProviderOutcome {
    if (this.#failed !== undefined) return this.#failed;
    const outcome = outcomeOfNvidiaResponse({
      ...(this.#id === undefined ? {} : { id: this.#id }),
      choices: [
        {
          finish_reason: this.#finishReason,
          message: { role: 'assistant', content: this.#raw },
        },
      ],
      usage: this.#usage,
    });
    // What went out must be the answer exactly, or none of it counts.
    if (outcome.status === 'success' && (outcome.output.text ?? '').length !== this.#released) {
      return error('invalid_response');
    }
    return outcome;
  }

  /** What is still held at the end: the answer after a short start that looked like a trace. */
  rest(): string {
    const answer = withoutReasoning(this.#raw);
    if (answer === undefined) return '';
    const out = answer.slice(this.#released);
    this.#released = answer.length;
    return out;
  }

  #fail(outcome: ProviderOutcome): undefined {
    this.#failed = outcome;
    return undefined;
  }
}

/** Whether a refused request's body says the input did not fit the model's context. */
const saysContextOverflow = (text: string): boolean =>
  /context[ _-]?length|maximum context|too many tokens|prompt is too long/i.test(text);

export function createNvidiaAdapter(options: NvidiaAdapterOptions): ProviderAdapter {
  const baseUrl = options.baseUrl ?? NVIDIA_HOSTED_BASE_URL;
  if (!BASE_URL.test(baseUrl)) throw new Error('invalid_nvidia_base_url');
  const chatUrl = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const call = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const ttl = options.credentialTtlMs ?? 300_000;
  let held: { readonly credential: ProviderCredential; readonly until: number } | undefined;

  async function credentialFor(request: ProviderCall): Promise<ProviderCredential | undefined> {
    if (held !== undefined && now().getTime() < held.until) return held.credential;
    try {
      const credential = await options.credentials.resolve(request.credential);
      held = { credential, until: now().getTime() + ttl };
      return credential;
    } catch {
      return undefined;
    }
  }

  /**
   * Checks a call, reads the key and sends `body`: NVIDIA's answer when it accepted the call, or
   * the classified error.
   */
  async function open(
    request: ProviderCall,
    body: Record<string, unknown> | undefined,
  ): Promise<{ readonly answer: Response; readonly signal: AbortSignal } | ProviderOutcome> {
    if (request.credential.provider !== NVIDIA_PROVIDER.credential.provider) {
      return error('authentication');
    }
    if (request.capability !== 'text_generation' || request.outputModality !== 'text') {
      return error('invalid_request');
    }
    if (body === undefined) return error('invalid_request');
    const remaining = request.deadline.getTime() - now().getTime();
    if (remaining <= 0) return error('timeout');
    const signal = AbortSignal.timeout(remaining);

    const credential = await credentialFor(request);
    if (credential === undefined) return error('authentication');
    let answer: Response;
    try {
      answer = await call(chatUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential.reveal()}`,
          'content-type': 'application/json',
          accept: body.stream === true ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      return signal.aborted ? error('timeout') : error('network');
    }
    if (!answer.ok) {
      // A refused key is dropped, so the next call reads it again.
      if (answer.status === 401 || answer.status === 403) held = undefined;
      const kind = errorKindOfStatus(answer.status);
      if (kind === 'rate_limited') {
        return error(
          kind,
          answer.status,
          retryAfterMsOf(answer.headers.get('retry-after'), now().getTime()),
        );
      }
      if (kind === 'invalid_request') {
        const text = await answer.text().catch(() => '');
        if (saysContextOverflow(text.slice(0, MAX_ERROR_BYTES))) {
          return error('context_overflow', answer.status);
        }
      }
      return error(kind, answer.status);
    }
    return { answer, signal };
  }

  return Object.freeze({
    providerId: NVIDIA_PROVIDER.id,
    adapterVersion: NVIDIA_ADAPTER_VERSION,
    capabilities: () => NVIDIA_PROVIDER.capabilities,
    // No probe: a failed call says more, and costs nothing. The gateway tracks health.
    health: async () => 'available' as const,

    async generate(request: ProviderCall): Promise<ProviderOutcome> {
      try {
        const opened = await open(request, nvidiaRequestOf(request));
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
        return outcomeOfNvidiaResponse(parsed);
      } catch {
        return error('invalid_response');
      }
    },

    // Streaming (R4, ADR-0077): server-sent chunks with the usage at the end, text only.
    async *stream(request: ProviderCall): AsyncGenerator<ProviderStreamEvent> {
      const end = (outcome: ProviderOutcome): ProviderStreamEvent =>
        Object.freeze({ type: 'end', outcome });
      if (request.structuredOutput || (request.tools?.length ?? 0) > 0) {
        yield end(error('invalid_request'));
        return;
      }
      let opened: Awaited<ReturnType<typeof open>>;
      try {
        const body = nvidiaRequestOf(request);
        opened = await open(
          request,
          body === undefined
            ? undefined
            : { ...body, stream: true, stream_options: { include_usage: true } },
        );
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
      const chunks = new NvidiaStreamChunks();
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
      const rest = chunks.rest();
      if (rest.length > 0) yield Object.freeze({ type: 'text', text: rest });
      yield end(chunks.outcome());
    },
  });
}
