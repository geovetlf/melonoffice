import type { AuthenticatedContext } from '@melonoffice/auth';
import type { UserId } from '@melonoffice/domain';
import { TenancyError } from './errors.js';

/**
 * The MelonOffice platform administrator acting (ADR-0082, ADR-0091). It only exists through
 * `resolvePlatformAdmin()`: the person is on the configured list (`PLATFORM_ADMIN_USER_IDS`),
 * acts directly (never GIA or the runtime) and their email is verified. It is not a membership
 * and grants nothing inside an organization; it is what platform operations such as a manual
 * credit grant are given, so they can check who authorized them.
 */
export interface PlatformAdminContext {
  readonly userId: UserId;
  readonly role: 'platform_admin';
}

// Every context resolvePlatformAdmin returns, and nothing else (as for tenants).
const issued = new WeakSet<PlatformAdminContext>();

/** Whether this exact object came from `resolvePlatformAdmin()`. */
export const isResolvedPlatformAdmin = (context: PlatformAdminContext): boolean =>
  issued.has(context);

/**
 * Checks, on the server, that the caller is a platform administrator. `admins` is configuration,
 * never a role a company can grant. Refuses with `platform_forbidden` for anyone else, and with
 * `platform_email_unverified` for a listed administrator whose email is not verified: the check is
 * made before anything is changed.
 */
export function resolvePlatformAdmin(
  auth: AuthenticatedContext,
  admins: ReadonlySet<string>,
): PlatformAdminContext {
  if (auth.actor !== 'user' || !admins.has(auth.userId)) {
    throw new TenancyError('platform_forbidden');
  }
  if (!auth.emailVerified) throw new TenancyError('platform_email_unverified');
  const context: PlatformAdminContext = Object.freeze({
    userId: auth.userId,
    role: 'platform_admin',
  });
  issued.add(context);
  return context;
}
