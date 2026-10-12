import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { holdPasskeyConfirmation } from './passkeyConfirmation.js';

/**
 * Passkeys through the API (ADR-0188). The device's own sign-in (fingerprint, face, PIN) answers;
 * the API checks every answer and decides what it allows. Nothing secret is kept here except the
 * 30-minute confirmation, in memory.
 */

export interface PasskeyView {
  readonly id: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface PasskeyOverview {
  /** Whether passkeys are set up on this server at all. */
  readonly available: boolean;
  /** Whether this person administers something, and so may have passkeys. */
  readonly administrator: boolean;
  readonly passkeys: readonly PasskeyView[];
  readonly confirmedUntil: string | null;
}

export class PasskeyRequestError extends Error {
  override readonly name = 'PasskeyRequestError';
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** The device's ceremony, swappable in tests. */
export interface PasskeyDevice {
  supported(): boolean;
  register(options: PublicKeyCredentialCreationOptionsJSON): Promise<unknown>;
  confirm(options: PublicKeyCredentialRequestOptionsJSON): Promise<unknown>;
}

export const browserPasskeyDevice: PasskeyDevice = {
  supported: () => browserSupportsWebAuthn(),
  register: (optionsJSON) => startRegistration({ optionsJSON }),
  confirm: (optionsJSON) => startAuthentication({ optionsJSON }),
};

export interface PasskeysClient {
  overview(): Promise<PasskeyOverview>;
  /** Adds a passkey on this device. */
  add(): Promise<PasskeyView>;
  /** Confirms with a passkey: later administrative changes go through for 30 minutes. */
  confirm(): Promise<{ readonly expiresAt: string }>;
  remove(passkeyId: string): Promise<void>;
  /** A platform administrator removes every passkey of someone who lost theirs. */
  reset(userId: string): Promise<number>;
  /** Whether this browser can use passkeys at all. */
  supported(): boolean;
}

export function createPasskeysClient(
  request: (path: string, init: RequestInit) => Promise<Response>,
  device: PasskeyDevice = browserPasskeyDevice,
): PasskeysClient {
  const call = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await request(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new PasskeyRequestError(
        response.status,
        typeof payload.error === 'string' ? payload.error : String(response.status),
      );
    }
    return payload as T;
  };
  const base = '/v1/me/passkeys';
  return {
    supported: () => device.supported(),
    overview: () => call<PasskeyOverview>(base),
    async add() {
      const { challengeId, options } = await call<{
        challengeId: string;
        options: PublicKeyCredentialCreationOptionsJSON;
      }>(`${base}/registration-options`, 'POST', {});
      const response = await device.register(options);
      return (await call<{ passkey: PasskeyView }>(base, 'POST', { challengeId, response }))
        .passkey;
    },
    async confirm() {
      const { challengeId, options } = await call<{
        challengeId: string;
        options: PublicKeyCredentialRequestOptionsJSON;
      }>(`${base}/confirmation-options`, 'POST', {});
      const response = await device.confirm(options);
      const confirmed = await call<{ token: string; expiresAt: string }>(
        `${base}/confirmations`,
        'POST',
        { challengeId, response },
      );
      holdPasskeyConfirmation(confirmed.token, confirmed.expiresAt);
      return { expiresAt: confirmed.expiresAt };
    },
    async remove(passkeyId) {
      await call(`${base}/${encodeURIComponent(passkeyId)}`, 'DELETE');
    },
    async reset(userId) {
      return (
        await call<{ removed: number }>(
          `/v1/platform/users/${encodeURIComponent(userId)}/passkeys/reset`,
          'POST',
          {},
        )
      ).removed;
    },
  };
}
