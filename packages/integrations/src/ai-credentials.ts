import { ProviderCredential, type CredentialResolver } from '@melonoffice/ai-gateway';
import type { CredentialReference, SecretRef } from '@melonoffice/domain';
import { IntegrationError } from './errors.js';
import { isAISecretRef, type SecretStore } from './secrets.js';

/**
 * AI provider keys from Secret Manager (LLM Router, ADR-0072). Each provider credential name
 * maps to one `ai-*` secret set in the service's configuration; any other name is refused. The
 * key goes straight into a `ProviderCredential`, which never prints it.
 */
export function aiProviderKeysFromSecrets(
  store: SecretStore,
  secrets: Readonly<Record<string, SecretRef>>,
): CredentialResolver {
  for (const ref of Object.values(secrets)) {
    if (!isAISecretRef(ref)) throw new IntegrationError('secret_not_found');
  }
  const refs = new Map(Object.entries(secrets));
  return Object.freeze({
    async resolve(reference: CredentialReference) {
      const ref = refs.get(reference.provider);
      if (ref === undefined) throw new IntegrationError('secret_not_found');
      return new ProviderCredential(await store.read(ref));
    },
  });
}
