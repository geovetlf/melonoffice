import type { SecretRef } from '@melonoffice/domain';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { aiProviderKeysFromSecrets } from './ai-credentials.js';
import {
  createSecretManagerStore,
  isAISecretRef,
  isSecretRef,
  type SecretStore,
} from './secrets.js';

/**
 * AI provider keys from Secret Manager (ADR-0072): only `ai-*` secrets, only for the providers
 * configured, and the key is never printed.
 */

const fake = (...parts: string[]) => parts.join('');
const KEY = fake('sk', '-ai-key-test-only-000001');
const AI_REF =
  'projects/melonoffice-dev-test/secrets/ai-deepseek-api-key/versions/latest' as SecretRef;
const CHANNEL_REF =
  'projects/melonoffice-dev-test/secrets/channel-11111111-1111-4111-8111-111111111111-access-token/versions/latest' as SecretRef;

function memory(values: Record<string, string>): SecretStore & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async read(ref) {
      reads.push(ref);
      const value = values[ref];
      if (value === undefined) throw new Error('secret_not_found');
      return value;
    },
  };
}

describe('AI secret references', () => {
  it('accepts only ai-* references, and keeps them apart from channel ones', () => {
    expect(isAISecretRef(AI_REF)).toBe(true);
    expect(isAISecretRef(CHANNEL_REF)).toBe(false);
    expect(isSecretRef(AI_REF)).toBe(false);
    expect(isAISecretRef('projects/melonoffice-dev-test/secrets/ai-x/versions/3')).toBe(false);
    expect(isAISecretRef(KEY)).toBe(false);
  });

  it('a store for AI keys refuses channel secrets, and the channel store refuses AI keys', async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response('{}', { status: 500 });
    }) as typeof fetch;
    const ai = createSecretManagerStore({ fetch: fetchFn, accepts: isAISecretRef });
    await expect(ai.read(CHANNEL_REF)).rejects.toMatchObject({ code: 'secret_not_found' });
    const channels = createSecretManagerStore({ fetch: fetchFn });
    await expect(channels.read(AI_REF)).rejects.toMatchObject({ code: 'secret_not_found' });
    expect(calls).toHaveLength(0);
  });
});

describe('secret credential resolver', () => {
  it('reads the configured provider key, and never prints it', async () => {
    const store = memory({ [AI_REF]: KEY });
    const resolver = aiProviderKeysFromSecrets(store, { deepseek: AI_REF });
    const credential = await resolver.resolve({ provider: 'deepseek', scopes: [] });
    expect(credential.reveal()).toBe(KEY);
    expect(JSON.stringify({ credential })).not.toContain(KEY);
    expect(inspect(credential)).not.toContain(KEY);
    expect(store.reads).toEqual([AI_REF]);
  });

  it('refuses a provider it was not given, and a reference that is not an AI secret', async () => {
    const store = memory({ [AI_REF]: KEY });
    const resolver = aiProviderKeysFromSecrets(store, { deepseek: AI_REF });
    await expect(resolver.resolve({ provider: 'other', scopes: [] })).rejects.toMatchObject({
      code: 'secret_not_found',
    });
    expect(store.reads).toHaveLength(0);
    expect(() => aiProviderKeysFromSecrets(store, { deepseek: CHANNEL_REF })).toThrow();
  });
});
