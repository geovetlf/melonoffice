/**
 * Structured JSON logger for server services.
 *
 * One JSON object per line on stdout. The `severity` field follows the
 * Google Cloud Logging convention so logs are parsed without an agent, but
 * no vendor SDK is used.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that adds `bindings` to every entry (e.g. a request id). */
  child(bindings: LogFields): Logger;
}

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  readonly service: string;
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  readonly now?: () => Date;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SEVERITY: Readonly<Record<LogLevel, string>> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
};

/** Field names whose values are never written to logs. */
const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential/i;

export const REDACTED = '[REDACTED]';

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(inner, depth + 1);
  }
  return result;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(LEVEL_ORDER, value);
}

export function createLogger(options: LoggerOptions, bindings: LogFields = {}): Logger {
  const minimum = LEVEL_ORDER[options.level ?? 'info'];
  const sink: LogSink = options.sink ?? ((line) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const write = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    if (LEVEL_ORDER[level] < minimum) return;
    const entry = {
      ...(redact({ ...bindings, ...fields }) as Record<string, unknown>),
      severity: SEVERITY[level],
      message,
      service: options.service,
      time: now().toISOString(),
    };
    sink(JSON.stringify(entry));
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (extra) => createLogger(options, { ...bindings, ...extra }),
  };
}
