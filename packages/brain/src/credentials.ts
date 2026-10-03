import { looksLikeCredentialName } from '@melonoffice/ai-gateway';
import type { KnowledgeItem } from '@melonoffice/domain';
import { valueText } from './knowledge.js';

/**
 * Credentials someone stored in the company memory (G-7): passwords, PINs, access keys, tokens.
 * They stay stored for the people who may read them, but they never go into the context a model
 * reads, whoever asks (agents, GIA, the knowledge tool), and an answer that repeats one is a
 * critical Guardian finding. The first eval baseline (2026-10-03) showed agents copying them when
 * asked for "all the data". They are found by the fact's label or key, with the AI Gateway's own
 * credential names: a value cannot tell a password from a product code.
 */
export function isCredentialFact(fact: {
  readonly key?: string;
  readonly label?: string;
}): boolean {
  return [fact.label, fact.key].some((name) => name !== undefined && looksLikeCredentialName(name));
}

/** Credentials shorter than this are not looked for in answers: they would match by chance. */
const MIN_SECRET_LENGTH = 4;

/**
 * What an answer must never repeat: an active credential fact's value. Only the Guardian reads
 * the value, to compare; nothing it keeps, logs or shows carries it.
 */
export interface StoredSecret {
  readonly factId: string;
  readonly label: string;
  readonly value: string;
}

export function storedSecretsOf(
  items: readonly Pick<KnowledgeItem, 'id' | 'key' | 'label' | 'value' | 'status'>[],
): readonly StoredSecret[] {
  return items.flatMap((item): StoredSecret[] => {
    if (item.status !== 'active' || !isCredentialFact(item)) return [];
    const value = valueText(item.value).trim();
    if ([...value].length < MIN_SECRET_LENGTH) return [];
    return [{ factId: item.id, label: item.label ?? item.key, value }];
  });
}
