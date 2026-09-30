import { actorOf, type AuditAction, type AuditService } from '@melonoffice/audit';
import {
  isTenancyError,
  resolvePlatformAdmin,
  type PlatformAdminContext,
} from '@melonoffice/tenancy';
import type { Context } from 'hono';
import { recordOutcome, requestFields } from './audit.js';
import type { AuthEnv } from './auth.js';

/**
 * The one server-side check for every `/v1/platform/*` route (ADR-0082, ADR-0091): the caller is
 * on `PLATFORM_ADMIN_USER_IDS`, acts directly and has a verified email. The browser only decides
 * whether to show the screens; this decides what runs.
 *
 * Answers the context, or the refusal to send: 403 `platform_forbidden` for anyone who is not an
 * administrator, 403 `platform_email_unverified` for an administrator whose email is not verified.
 * With `denied`, a refusal is audited under that action first. Nothing is changed before this.
 */
export async function platformAdminOf(
  c: Context<AuthEnv>,
  admins: ReadonlySet<string>,
  denied?: {
    readonly audit: AuditService;
    readonly action: AuditAction;
    /** What was asked for, when the action's events name it (the platform view read). */
    readonly reference?: string;
  },
): Promise<PlatformAdminContext | Response> {
  const auth = c.get('auth');
  try {
    return resolvePlatformAdmin(auth, admins);
  } catch (error) {
    if (!isTenancyError(error)) throw error;
    const code = error.code === 'platform_email_unverified' ? error.code : 'platform_forbidden';
    if (denied !== undefined) {
      await recordOutcome(c, denied.audit, {
        action: denied.action,
        result: 'denied',
        actor: actorOf(auth),
        reason: code === 'platform_forbidden' ? 'not_platform_admin' : code,
        ...(denied.reference === undefined ? {} : { reference: denied.reference }),
        ...requestFields(c),
      });
    }
    return c.json({ error: code }, 403);
  }
}
