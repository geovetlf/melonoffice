import {
  actorOf,
  type AuditAction,
  type AuditEventInput,
  type AuditService,
} from '@melonoffice/audit';
import { signedInRecently } from '@melonoffice/auth';
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
 *
 * A change (any method but GET) also needs a recent sign-in (ADR-0138): 403
 * `reauthentication_required` otherwise, and the person signs in again.
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
  now: () => Date = () => new Date(),
): Promise<PlatformAdminContext | Response> {
  const auth = c.get('auth');
  let admin: PlatformAdminContext;
  try {
    admin = resolvePlatformAdmin(auth, admins);
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
  const refused = await staleSignInRefusal(c, now(), denied);
  return refused ?? admin;
}

/** The method of a change: sensitive administration asks for a recent sign-in only for these. */
const changes = (c: Context<AuthEnv>) => c.req.method !== 'GET' && c.req.method !== 'HEAD';

/**
 * For a change by a sensitive administrator (platform, white label, reseller), the refusal to send
 * when they did not sign in recently (ADR-0138), audited under `denied` when given; otherwise
 * undefined. Reads are never refused for this.
 */
export async function staleSignInRefusal(
  c: Context<AuthEnv>,
  now: Date,
  denied?: {
    readonly audit: AuditService;
    readonly action: AuditAction;
  } & Pick<AuditEventInput, 'reference' | 'commercialAccountId' | 'permission'>,
): Promise<Response | undefined> {
  const auth = c.get('auth');
  if (!changes(c) || signedInRecently(auth, now)) return undefined;
  if (denied !== undefined) {
    await recordOutcome(c, denied.audit, {
      action: denied.action,
      result: 'denied',
      actor: actorOf(auth),
      reason: 'reauthentication_required',
      ...(denied.reference === undefined ? {} : { reference: denied.reference }),
      ...(denied.commercialAccountId === undefined
        ? {}
        : { commercialAccountId: denied.commercialAccountId }),
      ...(denied.permission === undefined ? {} : { permission: denied.permission }),
      ...requestFields(c),
    });
  }
  return c.json({ error: 'reauthentication_required' }, 403);
}
