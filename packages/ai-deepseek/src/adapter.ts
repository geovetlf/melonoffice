import type {
  AIMessage,
  AIOutputSchema,
  CredentialResolver,
  FinishReason,
  ProviderAdapter,
  ProviderCall,
  ProviderCredential,
  ProviderErrorKind,
  ProviderOutcome,
} from '@melonoffice/ai-gateway';
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
export const DEEPSEEK_ADAPTER_VERSION = '1';
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

/** The request body, or undefined when the call asks for something this adapter cannot send. */
export function deepSeekRequestOf(call: ProviderCall): Record<string, unknown> | undefined {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];
  for (const message of call.messages as readonly AIMessage[]) {
    const texts: string[] = [];
    for (const part of message.content) {
      // Text only in this version.
      if (part.type !== 'text') return undefined;
      texts.push(part.text);
    }
    messages.push({ role: message.role, content: texts.join('\n') });
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
  };
}

const FINISH: Readonly<Record<string, FinishReason>> = {
  stop: 'stop',
  length: 'length',
  content_filter: 'content_filter',
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
  // Only the answer: `reasoning_content` is never passed on.
  if (!isRecord(message) || typeof message.content !== 'string') return error('invalid_response');
  let output: { text?: string; structured?: unknown } = { text: message.content };
  if (structured) {
    try {
      output = { structured: JSON.parse(message.content) as unknown };
    } catch {
      // Left as text: the caller checks it, and refuses what it cannot read.
    }
  }
  const id = body.id;
  return Object.freeze({
    status: 'success',
    output: Object.freeze(output),
    // Reasoning is billed within `completion_tokens`: counted, never under-charged.
    usage: Object.freeze({
      inputTokens,
      outputTokens,
      ...(cached > 0 ? { cachedInputTokens: Math.min(cached, inputTokens) } : {}),
    }),
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
