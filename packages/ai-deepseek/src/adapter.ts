import type {
  AIMessage,
  AIOutputSchema,
  AIToolCall,
  CredentialResolver,
  FinishReason,
  ProviderAdapter,
  ProviderCall,
  ProviderCredential,
  ProviderErrorKind,
  ProviderOutcome,
} from '@melonoffice/ai-gateway';
import type { ToolSchema } from '@melonoffice/domain';
import { DEEPSEEK_PROVIDER } from './catalogue.js';

/**
 * The DeepSeek adapter (ADR-0072): translates the gateway's `ProviderCall` to DeepSeek's official
 * chat completions API and its answer back, and nothing more. It is the only code that knows
 * DeepSeek's endpoint, request and response format. No SDK.
 *
 * Its API key comes from a `CredentialResolver` (Secret Manager on the server), is kept in memory
 * for a short while so a call does not read Secret Manager each time, and never leaves this file.
 * It never throws: every failure is a classified `ProviderOutcome` error without DeepSeek's
 * message, so nothing DeepSeek says reaches a log, an audit event or a person.
 */
export const DEEPSEEK_ADAPTER_VERSION = '2';
export const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

export interface DeepSeekAdapterOptions {
  readonly credentials: CredentialResolver;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  /** How long a resolved key is kept before it is read again. */
  readonly credentialTtlMs?: number;
}

const MODEL = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const RESPONSE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RESPONSE_BYTES = 1_000_000;
/** Only this much of an error body is read, to tell a context overflow from other refusals. */
const MAX_ERROR_BYTES = 4_096;

const error = (kind: ProviderErrorKind, httpStatus?: number): ProviderOutcome =>
  Object.freeze({ status: 'error', kind, ...(httpStatus === undefined ? {} : { httpStatus }) });

/**
 * An HTTP status as DeepSeek answers it, as a gateway error kind. 402 (no balance on the account)
 * is the account's problem, not a passing one: not retried, but another provider may answer.
 */
export function errorKindOfStatus(status: number): ProviderErrorKind {
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 402 || status === 403) return 'authentication';
  if (status === 503) return 'unavailable';
  if (status >= 500) return 'server_error';
  return 'invalid_request';
}

/** The closed output schema as plain words for the system message. Names only, no free text. */
export function describeSchema(schema: AIOutputSchema): string {
  const nullable = schema.nullable === true ? ' or null' : '';
  switch (schema.type) {
    case 'string':
      return schema.enum === undefined
        ? `string${nullable}`
        : `one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}${nullable}`;
    case 'number':
    case 'integer':
    case 'boolean':
      return `${schema.type}${nullable}`;
    case 'array':
      return `array of ${describeSchema(schema.items)}${nullable}`;
    case 'object': {
      const required = new Set(schema.required ?? []);
      const fields = Object.entries(schema.properties).map(
        ([name, s]) => `"${name}"${required.has(name) ? '' : ' (optional)'}: ${describeSchema(s)}`,
      );
      return `object { ${fields.join('; ')} }${nullable}`;
    }
  }
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

/** The request body, or undefined when the call asks for something this adapter cannot send. */
export function deepSeekRequestOf(call: ProviderCall): Record<string, unknown> | undefined {
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
  if (call.structuredOutput) {
    // DeepSeek's JSON mode needs the word "json" and the expected shape in the prompt.
    messages.unshift({
      role: 'system',
      content:
        call.outputSchema === undefined
          ? 'Answer with one JSON object.'
          : `Answer with one JSON object of this shape: ${describeSchema(call.outputSchema)}.`,
    });
  }
  return {
    model: call.model.id,
    messages,
    max_tokens: call.maxOutputTokens,
    temperature: 0.2,
    stream: false,
    ...(call.structuredOutput ? { response_format: { type: 'json_object' } } : {}),
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

/** DeepSeek's answer as a gateway outcome; anything unexpected is an invalid response. */
export function outcomeOfDeepSeekResponse(body: unknown, structured: boolean): ProviderOutcome {
  if (!isRecord(body)) return error('invalid_response');
  const usage = body.usage;
  if (!isRecord(usage)) return error('invalid_response');
  const inputTokens = count(usage.prompt_tokens);
  const outputTokens = count(usage.completion_tokens);
  const cached =
    usage.prompt_cache_hit_tokens === undefined ? 0 : count(usage.prompt_cache_hit_tokens);
  // Without usage the call cannot be charged: it is not passed on.
  if (inputTokens === undefined || outputTokens === undefined || cached === undefined) {
    return error('invalid_response');
  }
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return error('invalid_response');
  const [choice] = choices as unknown[];
  if (!isRecord(choice)) return error('invalid_response');
  const reason = choice.finish_reason;
  if (reason === 'content_filter') return error('content_policy');
  if (reason === 'insufficient_system_resource') return error('unavailable');
  const finishReason = typeof reason === 'string' ? FINISH[reason] : undefined;
  if (finishReason === undefined) return error('invalid_response');
  const message = choice.message;
  if (!isRecord(message)) return error('invalid_response');
  const id = body.id;
  const usageOf = Object.freeze({
    inputTokens,
    outputTokens,
    ...(cached > 0 ? { cachedInputTokens: Math.min(cached, inputTokens) } : {}),
  });
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
    const text = typeof message.content === 'string' ? message.content : '';
    return Object.freeze({
      status: 'success',
      output: Object.freeze({
        ...(text.length === 0 ? {} : { text }),
        toolCalls: Object.freeze(toolCalls),
      }),
      usage: usageOf,
      finishReason,
      ...(typeof id === 'string' && RESPONSE_ID.test(id) ? { providerRequestId: id } : {}),
    });
  }
  // Only the answer: `reasoning_content` is never passed on.
  if (typeof message.content !== 'string') return error('invalid_response');
  let output: { text?: string; structured?: unknown } = { text: message.content };
  if (structured) {
    try {
      output = { structured: JSON.parse(message.content) as unknown };
    } catch {
      // Left as text: the caller checks it, and refuses what it cannot read.
    }
  }
  return Object.freeze({
    status: 'success',
    output: Object.freeze(output),
    // Reasoning is billed within `completion_tokens`: counted, never under-charged.
    usage: usageOf,
    finishReason,
    ...(typeof id === 'string' && RESPONSE_ID.test(id) ? { providerRequestId: id } : {}),
  });
}

/** Whether a refused request's body says the input did not fit the model's context. */
const saysContextOverflow = (text: string): boolean =>
  /context[ _-]?length|maximum context|too many tokens/i.test(text);

export function createDeepSeekAdapter(options: DeepSeekAdapterOptions): ProviderAdapter {
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

  return Object.freeze({
    providerId: DEEPSEEK_PROVIDER.id,
    adapterVersion: DEEPSEEK_ADAPTER_VERSION,
    capabilities: () => DEEPSEEK_PROVIDER.capabilities,
    // No probe: a failed call says more, and costs nothing. The gateway tracks health.
    health: async () => 'available' as const,

    async generate(request: ProviderCall): Promise<ProviderOutcome> {
      try {
        if (request.credential.provider !== DEEPSEEK_PROVIDER.credential.provider) {
          return error('authentication');
        }
        if (request.capability !== 'text_generation' || request.outputModality !== 'text') {
          return error('invalid_request');
        }
        if (!MODEL.test(request.model.id)) return error('invalid_request');
        const body = deepSeekRequestOf(request);
        if (body === undefined) return error('invalid_request');
        const remaining = request.deadline.getTime() - now().getTime();
        if (remaining <= 0) return error('timeout');
        const signal = AbortSignal.timeout(remaining);

        const credential = await credentialFor(request);
        if (credential === undefined) return error('authentication');
        let answer: Response;
        try {
          answer = await call(DEEPSEEK_API_URL, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${credential.reveal()}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(body),
            signal,
          });
        } catch {
          return signal.aborted ? error('timeout') : error('network');
        }
        if (!answer.ok) {
          // A refused key is dropped, so the next call reads it again.
          if (answer.status === 401) held = undefined;
          const kind = errorKindOfStatus(answer.status);
          if (kind === 'invalid_request') {
            const text = await answer.text().catch(() => '');
            if (saysContextOverflow(text.slice(0, MAX_ERROR_BYTES))) {
              return error('context_overflow', answer.status);
            }
          }
          return error(kind, answer.status);
        }
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
        return outcomeOfDeepSeekResponse(parsed, request.structuredOutput);
      } catch {
        return error('invalid_response');
      }
    },
  });
}
