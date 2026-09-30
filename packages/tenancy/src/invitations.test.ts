import type { CustomerInvitation, IsoTimestamp, UserId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import {
  hashInvitationToken,
  invitationStatusAt,
  isInvitationToken,
  isInvitedPerson,
  newInvitationToken,
  parseInvitationEmail,
} from './invitations.js';

const invitation = (overrides: Partial<CustomerInvitation> = {}): CustomerInvitation => ({
  id: '11111111-1111-4111-8111-111111111111' as CustomerInvitation['id'],
  commercialAccountId:
    '22222222-2222-4222-8222-222222222222' as CustomerInvitation['commercialAccountId'],
  email: 'ana@example.com',
  mode: 'reseller',
  scopes: [],
  status: 'pending',
  tokenHash: '0'.repeat(64),
  expiresAt: '2026-10-07T00:00:00.000Z' as IsoTimestamp,
  createdBy: 'u1' as UserId,
  createdAt: '2026-09-30T00:00:00.000Z' as IsoTimestamp,
  updatedAt: '2026-09-30T00:00:00.000Z' as IsoTimestamp,
  ...overrides,
});

describe('invitations (ADR-0089)', () => {
  it('makes a fresh secret each time and stores only its hash', () => {
    const a = newInvitationToken();
    const b = newInvitationToken();
    expect(isInvitationToken(a.token)).toBe(true);
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).toBe(hashInvitationToken(a.token));
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.tokenHash).not.toContain(a.token);
  });

  it('normalizes the invited email and refuses anything else', () => {
    expect(parseInvitationEmail('  Ana@Example.COM ')).toBe('ana@example.com');
    for (const bad of [
      '',
      'ana',
      'ana@example',
      'a b@example.com',
      42,
      `${'a'.repeat(250)}@x.co`,
    ]) {
      expect(() => parseInvitationEmail(bad)).toThrow('invalid_invitation_email');
    }
  });

  it('is expired from its time on, only while pending', () => {
    const at = new Date('2026-10-07T00:00:00.000Z');
    expect(invitationStatusAt(invitation(), new Date(at.getTime() - 1))).toBe('pending');
    expect(invitationStatusAt(invitation(), at)).toBe('expired');
    expect(invitationStatusAt(invitation({ status: 'accepted' }), at)).toBe('accepted');
  });

  it('belongs only to a person with that very email, verified', () => {
    const auth = { actor: 'user' as const, userId: 'u2' as UserId, emailVerified: true };
    expect(isInvitedPerson({ ...auth, email: 'ANA@example.com' }, invitation())).toBe(true);
    expect(isInvitedPerson({ ...auth, email: 'ana@example.org' }, invitation())).toBe(false);
    expect(isInvitedPerson({ ...auth }, invitation())).toBe(false);
    expect(
      isInvitedPerson({ ...auth, email: 'ana@example.com', emailVerified: false }, invitation()),
    ).toBe(false);
    expect(isInvitedPerson({ ...auth, actor: 'gia', email: 'ana@example.com' }, invitation())).toBe(
      false,
    );
  });
});
