/**
 * A provider, model or policy definition that cannot be accepted. Raised when the registry or a
 * policy is built, never while serving a call. `detail` names the field, never a secret.
 */
export class AIConfigError extends Error {
  override readonly name = 'AIConfigError';

  constructor(readonly detail: string) {
    super(`invalid_ai_configuration: ${detail}`);
  }
}
