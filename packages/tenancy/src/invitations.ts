import type { AuthenticatedContext } from '@melonoffice/auth';
import type {
  CustomerInvitation,
  CustomerInvitationId,
  CustomerInvitationStatus,
  MemberInvitationId,
} from '@melonoffice/domain';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { TenancyError } from './errors.js';

/**
 * Invitations by email to become a customer (ADR-0089). The link carries a random secret; only
 * its hash is stored, so a copy of the database cannot be turned into links. An invitation is
 * taken only by a signed-in person whose verified email is the invited one, and only while
 * pending and not expired.
 */

/** How long an invitation can be taken: 7 days (ADR-0089). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 32 random bytes in base64url: 43 characters. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;
// Deliberately plain: one @, no spaces, a dot in the domain. Identity Platform checks the rest.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;

export const INVITATION_STATUSES: readonly CustomerInvitationStatus[] = Object.freeze([
  'pending',
  'accepted',
  'rejected',
  'revoked',
  'expired',
]);

export const newCustomerInvitationId = (): CustomerInvitationId =>
  randomUUID() as CustomerInvitationId;

export const newMemberInvitationId = (): MemberInvitationId => randomUUID() as MemberInvitationId;

/** Whether a client-sent value can be a member invitation id (ADR-0093). It grants nothing. */
export const isMemberInvitationId = (value: unknown): value is MemberInvitationId =>
  typeof value === 'string' && UUID.test(value);

/** Whether a client-sent value can be an invitation id at all. It grants nothing. */
export const isCustomerInvitationId = (value: unknown): value is CustomerInvitationId =>
  typeof value === 'string' && UUID.test(value);

export const isInvitationToken = (value: unknown): value is string =>
  typeof value === 'string' && TOKEN.test(value);

export const isInvitationTokenHash = (value: unknown): value is string =>
  typeof value === 'string' && HASH.test(value);

export const hashInvitationToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** A new link secret and the hash that is stored in its place. */
export function newInvitationToken(): { readonly token: string; readonly tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInvitationToken(token) };
}

/** The invited email: trimmed and lowercased, so it compares with a signed-in person's. */
export function parseInvitationEmail(value: unknown): string {
  if (typeof value !== 'string') throw new TenancyError('invalid_invitation_email');
  const email = value.trim().toLowerCase();
  if (email.length > EMAIL_MAX || !EMAIL.test(email)) {
    throw new TenancyError('invalid_invitation_email');
  }
  return email;
}

/** A pending invitation past its time is expired, whether or not that was recorded yet. */
export const invitationStatusAt = (
  invitation: Pick<CustomerInvitation, 'status' | 'expiresAt'>,
  at: Date,
): CustomerInvitationStatus =>
  invitation.status === 'pending' && at.getTime() >= Date.parse(invitation.expiresAt)
    ? 'expired'
    : invitation.status;

/**
 * Whether this signed-in person is the one invited: a person, not GIA, whose email the identity
 * provider verified and which is the invited one.
 */
export const isInvitedPerson = (
  auth: AuthenticatedContext,
  invitation: Pick<CustomerInvitation, 'email'>,
): boolean =>
  auth.actor === 'user' &&
  auth.emailVerified &&
  auth.email !== undefined &&
  auth.email.trim().toLowerCase() === invitation.email;
