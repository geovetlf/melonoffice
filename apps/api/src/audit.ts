import type { AuditEventInput, AuditService } from '@melonoffice/audit';
import type { Context } from 'hono';
import type { AuthEnv } from './auth.js';

/** The request's fields every event carries: its id and the component recording it. */
export const requestFields = (c: Context<AuthEnv>) =>
  ({ requestId: c.get('requestId'), source: 'api' }) as const;

/**
 * Required events (ADR-0020): the request only succeeds if its event is stored. If it cannot be,
 * the caller gets `503 audit_unavailable` instead of a success nobody can trace.
 */
export async function recordRequired(
  c: Context<AuthEnv>,
  audit: AuditService,
  input: AuditEventInput,
): Promise<Response | undefined> {
  try {
    await audit.record(input);
    return undefined;
  } catch (error) {
    c.get('logger').error('audit write failed', {
      action: input.action,
      result: input.result,
      error,
    });
    return c.json({ error: 'audit_unavailable' }, 503);
  }
}

/**
 * Denials and failures (ADR-0020): the response is already a refusal or an error, and it stays
 * so whether or not the event is stored. A storage failure is logged as an error, never hidden
 * and never turned into access.
 */
export async function recordOutcome(
  c: Context<AuthEnv>,
  audit: AuditService,
  input: AuditEventInput,
): Promise<void> {
  try {
    await audit.record(input);
  } catch (error) {
    c.get('logger').error('audit write failed', {
      action: input.action,
      result: input.result,
      error,
    });
  }
}
