import {
  AuditEventConflict,
  createAuditService,
  stableAuditEventId,
  type AuditEventId,
  type AuditEventInput,
} from '@melonoffice/audit';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FirestoreAuditStore } from './audit.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

const NOW = new Date('2026-10-12T09:00:00Z');

/** A new id for each run: the emulator keeps what earlier runs wrote. */
const fresh = () => randomUUID();

describe.runIf(emulatorHost)('FirestoreAuditStore recordOnce (emulator, ADR-0044)', () => {
  it('stores an inbound message fact once, and a repeat finds the stored copy', async () => {
    const store = new FirestoreAuditStore(emulatorFirestore());
    const audit = createAuditService(store, () => NOW);
    const organizationId = fresh() as OrganizationId;
    const messageId = `wamid-${fresh()}`;
    const fact: AuditEventInput & { readonly id: AuditEventId } = {
      id: stableAuditEventId(`inbound:${messageId}`),
      action: 'conversation.message_received',
      result: 'success',
      // The contact is not a user: the channel's signature is the only authority.
      actor: { type: 'anonymous' },
      organizationId,
      target: { type: 'message', id: messageId },
      reference: 'conversation:conv-1',
      reason: 'whatsapp',
      source: 'api',
    };
    await expect(audit.recordOnce(fact)).resolves.toBe('written');
    await expect(audit.recordOnce(fact)).resolves.toBe('same');
    const history = await store.history(organizationId, { type: 'message', id: messageId }, 10);
    expect(history).toHaveLength(1);
    expect(await store.find(fact.id)).toMatchObject({
      id: fact.id,
      actor: { type: 'anonymous' },
      reason: 'whatsapp',
    });
  });

  it('refuses a different fact under a stored id, and keeps the first', async () => {
    const store = new FirestoreAuditStore(emulatorFirestore());
    const audit = createAuditService(store, () => NOW);
    const fact: AuditEventInput & { readonly id: AuditEventId } = {
      id: stableAuditEventId(`inbound:wamid-${fresh()}`),
      action: 'conversation.message_received',
      result: 'success',
      actor: { type: 'anonymous' },
      organizationId: fresh() as OrganizationId,
      target: { type: 'message', id: fresh() },
      reason: 'whatsapp',
      source: 'api',
    };
    await audit.recordOnce(fact);
    await expect(audit.recordOnce({ ...fact, reason: 'another_channel' })).rejects.toBeInstanceOf(
      AuditEventConflict,
    );
    expect((await store.find(fact.id))?.reason).toBe('whatsapp');
  });

  it('reads a user fact with its optional fields back as recorded, so a repeat is the same', async () => {
    const store = new FirestoreAuditStore(emulatorFirestore());
    const audit = createAuditService(store, () => NOW);
    const organizationId = fresh() as OrganizationId;
    const fact: AuditEventInput & { readonly id: AuditEventId } = {
      id: stableAuditEventId(`plan:${fresh()}`),
      action: 'plan.assign',
      result: 'success',
      actor: { type: 'user', userId: fresh() as UserId, via: 'gia' },
      organizationId,
      target: { type: 'organization', id: organizationId },
      targetVersion: 2,
      plan: { id: 'entrepreneur', version: 1 },
      reason: 'manual_change',
      requestId: 'req-1',
      source: 'api',
    };
    await expect(audit.recordOnce(fact)).resolves.toBe('written');
    await expect(audit.recordOnce(fact)).resolves.toBe('same');
  });
});
