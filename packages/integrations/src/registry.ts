import type { ChannelType, IntegrationCategory, IntegrationProviderId } from '@melonoffice/domain';
import type { ChannelAdapter } from './adapter.js';

/** Every category a plan can list, whether or not an adapter exists for it yet. */
export const INTEGRATION_CATEGORIES = [
  'messaging',
  'email',
  'calendar',
  'crm',
  'storage',
] as const satisfies readonly IntegrationCategory[];

export const isIntegrationCategory = (value: unknown): value is IntegrationCategory =>
  typeof value === 'string' && (INTEGRATION_CATEGORIES as readonly string[]).includes(value);

const PROVIDER_ID = /^[a-z][a-z0-9_]{2,40}$/;

export const isProviderId = (value: unknown): value is IntegrationProviderId =>
  typeof value === 'string' && PROVIDER_ID.test(value);

/**
 * The providers this server can speak to (ADR-0044): one adapter per official provider API. The
 * registry is the only place the Integration Engine finds an adapter, so a provider that is not
 * registered cannot be connected, receive or send. Built once from code: never from a request.
 */
export interface IntegrationRegistry {
  list(): readonly ChannelAdapter[];
  find(provider: string): ChannelAdapter | undefined;
  /** The provider that serves a channel (one per channel today). */
  forChannel(channel: string): ChannelAdapter | undefined;
}

export function createIntegrationRegistry(
  adapters: readonly ChannelAdapter[],
): IntegrationRegistry {
  const byProvider = new Map<string, ChannelAdapter>();
  const byChannel = new Map<string, ChannelAdapter>();
  for (const adapter of adapters) {
    if (!isProviderId(adapter.provider) || !isIntegrationCategory(adapter.category)) {
      throw new Error(`invalid provider: ${String(adapter.provider)}`);
    }
    if (byProvider.has(adapter.provider)) {
      throw new Error(`provider registered twice: ${adapter.provider}`);
    }
    if (byChannel.has(adapter.channel)) {
      // A second provider for the same channel needs a choice of provider per connection first.
      throw new Error(`channel served twice: ${adapter.channel}`);
    }
    byProvider.set(adapter.provider, adapter);
    byChannel.set(adapter.channel, adapter);
  }
  const all = Object.freeze([...adapters]);
  return Object.freeze({
    list: () => all,
    find: (provider: string) => byProvider.get(provider),
    forChannel: (channel: ChannelType | string) => byChannel.get(channel),
  });
}
