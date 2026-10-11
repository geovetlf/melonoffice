/**
 * The passkey confirmation this browser holds (ADR-0188): proof, for 30 minutes, that the person
 * just used one of their passkeys. Only in memory, never in storage: reloading the page or signing
 * out forgets it, and the API is what decides whether it still counts.
 */

let current: { readonly token: string; readonly expiresAt: number } | undefined;

/** The header the API reads it from. */
export const PASSKEY_CONFIRMATION_HEADER = 'x-melon-passkey';

export function holdPasskeyConfirmation(token: string, expiresAt: string): void {
  const at = Date.parse(expiresAt);
  current = Number.isNaN(at) ? undefined : { token, expiresAt: at };
}

/** The token while it lasts, else nothing. */
export function passkeyConfirmation(now: number = Date.now()): string | undefined {
  if (current !== undefined && current.expiresAt <= now) current = undefined;
  return current?.token;
}

export function forgetPasskeyConfirmation(): void {
  current = undefined;
}
