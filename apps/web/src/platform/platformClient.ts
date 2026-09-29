import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * The platform AI view through the API (ADR-0082): for the MelonOffice platform administrator
 * only. Which AI providers and models MelonMotor has, their prices and terms, how calls are
 * routed and fall back, how each provider is doing, and every organization's AI usage with
 * MelonOffice's internal cost. A company never reaches it: the server refuses anyone else.
 */

export interface PlatformProvider {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly health: 'available' | 'degraded' | 'unavailable';
  readonly capabilities: readonly string[];
  readonly environments: readonly string[];
  readonly maxSensitivity: string;
}

export type PlatformPricing =
  | { readonly status: 'unknown' }
  | {
      readonly status: 'known';
      readonly inputMicroUsdPerMillionTokens: number;
      readonly outputMicroUsdPerMillionTokens: number;
      readonly source: string;
      readonly asOf: string;
    };

export interface PlatformModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly version: string;
  readonly displayName: string | null;
  readonly status: string;
  readonly capabilities: readonly string[];
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly pricing: PlatformPricing;
  readonly environments: readonly string[];
  readonly maxSensitivity: string;
  readonly terms: { readonly offering: string; readonly production: string } | null;
}

export interface PlatformPolicy {
  readonly id: string;
  readonly version: number;
  readonly allowedModels: readonly string[] | null;
  readonly environments: readonly string[];
  readonly maxSensitivity: string;
  readonly maxCostMicroUsd: number | null;
  readonly strategy: string | null;
  readonly fallback: 'none' | 'compatible';
  readonly maxAttempts: number;
}

export interface PlatformAI {
  readonly environment: string | null;
  readonly providers: readonly PlatformProvider[];
  readonly models: readonly PlatformModel[];
  readonly policies: readonly PlatformPolicy[];
}

export interface PlatformBucket {
  readonly operations: number;
  /** MelonOffice's internal cost, in millionths of a US dollar. */
  readonly costMicroUsd: number;
  readonly unpricedOperations: number;
  readonly credits: number;
}

export interface PlatformUsage {
  readonly from: string;
  readonly to: string;
  readonly totals: PlatformBucket;
  readonly by: Partial<Record<string, Readonly<Record<string, PlatformBucket>>>>;
  readonly byOrganization: readonly (PlatformBucket & {
    readonly organizationId: string;
    readonly name: string | null;
  })[];
}

export class PlatformRequestError extends Error {
  override readonly name = 'PlatformRequestError';
  constructor(readonly status: number) {
    super(`platform request failed: ${status}`);
  }
}

export interface PlatformClient {
  /** Whether the signed-in person is a platform administrator; false on any failure. */
  access(): Promise<boolean>;
  ai(): Promise<PlatformAI>;
  usage(from: string, to: string): Promise<PlatformUsage>;
}

export function createPlatformClient(request: ReplyRequest): PlatformClient {
  const read = async <T>(path: string): Promise<T> => {
    const response = await request(path, {});
    if (!response.ok) throw new PlatformRequestError(response.status);
    return (await response.json()) as T;
  };
  return {
    access: () =>
      read<{ platformAdmin?: unknown }>('/v1/platform/access').then(
        (body) => body.platformAdmin === true,
        () => false,
      ),
    ai: () => read<PlatformAI>('/v1/platform/ai'),
    usage: (from, to) =>
      read<PlatformUsage>(`/v1/platform/ai-usage?${new URLSearchParams({ from, to }).toString()}`),
  };
}
