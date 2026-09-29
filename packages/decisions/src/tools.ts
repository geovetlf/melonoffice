import type { RecommendedAction } from './model.js';

/**
 * From a decision to a tool (ADR-0065). A decision may recommend an action; a tool runs only
 * through the Tool Engine: Decision → Tool Request → Permission → Approval → Execution → Audit
 * (the tool gate, ADR-0026/0034). This is the one place that says which recommended action maps
 * to which catalogue tool. Today none does: every recommended action is done or confirmed by a
 * person in the app. A tool joins here, with its version, when AE-4 adds it to the catalogue.
 */
export interface ToolRequestDraft {
  readonly toolId: string;
  readonly toolVersion: number;
  /** The record it would act on. The gate still checks everything again. */
  readonly target: { readonly type: string; readonly id: string };
}

export const RECOMMENDED_ACTION_TOOLS: Readonly<
  Record<string, { readonly toolId: string; readonly toolVersion: number }>
> = Object.freeze({});

/** The tool request a recommended action would become, or null when a person does it. */
export function toolRequestOf(action: RecommendedAction | null): ToolRequestDraft | null {
  if (action === null || action.link === null) return null;
  const tool = RECOMMENDED_ACTION_TOOLS[action.code];
  return tool === undefined ? null : Object.freeze({ ...tool, target: action.link });
}
