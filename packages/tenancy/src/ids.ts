import type { MembershipId, OrganizationId, UserId } from '@melonoffice/domain';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Organization ids: random and opaque, never derived from the name or anyone's email. */
export const newOrganizationId = (): OrganizationId => randomUUID() as OrganizationId;

/**
 * Whether a client-sent value can be an organization id at all. It says nothing about access;
 * it only keeps arbitrary strings away from storage lookups.
 */
export const isOrganizationId = (value: unknown): value is OrganizationId =>
  typeof value === 'string' && UUID.test(value);

/**
 * One membership per user and organization: its id is derived from the pair, so storage that
 * keys by id cannot hold two. Both parts are UUIDs, so the id is unambiguous.
 */
export const membershipIdOf = (organizationId: OrganizationId, userId: UserId): MembershipId =>
  `${organizationId}_${userId}` as MembershipId;
