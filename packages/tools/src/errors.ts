/** Why a tool definition or lookup was refused. Stable codes, safe to log. */
export type ToolErrorCode = 'invalid_tool' | 'tool_not_found';

export class ToolError extends Error {
  override readonly name = 'ToolError';

  constructor(
    readonly code: ToolErrorCode,
    /** Which field or rule, for `invalid_tool`. A code, never user data. */
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isToolError = (error: unknown): error is ToolError => error instanceof ToolError;
