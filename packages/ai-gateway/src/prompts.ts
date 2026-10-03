/**
 * Prompt versions (G-3, ADR-0133). Every place that writes a model's instructions names them as
 * `{id, version}`, the way skills and tools are named. The label `id@version` travels with the call
 * in its metadata (`prompt`), into the call's trace and the AI usage ledger, so results, cost and
 * failures can be compared per prompt version. Changing what a prompt says means a new version:
 * a test pins the digest of each version's text.
 */

export interface PromptRef {
  /** A code, e.g. `agent_task`. */
  readonly id: string;
  /** From 1; a new one whenever the prompt's text changes. */
  readonly version: number;
}

/** The metadata key a call carries its prompt version in. */
export const PROMPT_METADATA_KEY = 'prompt';

/** `id@version`, e.g. `agent_task@1`. */
export const PROMPT_LABEL = /^[a-z][a-z0-9_]{0,63}@[1-9]\d{0,5}$/;

export const promptRef = (id: string, version: number): PromptRef => {
  const ref = Object.freeze({ id, version });
  if (!PROMPT_LABEL.test(promptLabel(ref))) throw new Error(`invalid prompt ref ${id}@${version}`);
  return ref;
};

export const promptLabel = (ref: PromptRef): string => `${ref.id}@${ref.version}`;

/** The prompt version a call's metadata names, or undefined when it names none (or a bad one). */
export function promptOf(
  metadata: Readonly<Record<string, string | number | boolean>> | undefined,
): string | undefined {
  const value = metadata?.[PROMPT_METADATA_KEY];
  return typeof value === 'string' && PROMPT_LABEL.test(value) ? value : undefined;
}
