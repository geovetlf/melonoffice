import type { Execution } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import {
  GUARDIAN_LIMITS,
  guardAnswer,
  guardianWarningOf,
  isUncheckedReport,
  parseGuardianReport,
  UNCHECKED_FINDING,
} from './guardian.js';

// ADR-0132 (amended): when Company Brain cannot be read whole, the report says so and nothing more.
const base = {
  answer: 'Hola, gracias por escribir.',
  missing: [] as string[],
  execution: { nodes: [] } as Pick<Execution, 'nodes'>,
  mutating: () => true,
};

describe('the Guardian when Company Brain is not read whole', () => {
  it('says so as an informative finding, and raises no warning for the person', () => {
    const report = guardAnswer({ ...base, unchecked: true });
    expect(report.findings).toEqual([UNCHECKED_FINDING]);
    expect(isUncheckedReport(report)).toBe(true);
    // Only a finding above information raises the Guardian's warning, so this notice stays on the task.
    expect(guardianWarningOf(report)).toBeUndefined();
  });

  it('keeps its notice when the findings are cut to the limit', () => {
    // More failed tool steps than the list keeps: each is a warning, so they would fill it.
    const nodes = Array.from({ length: GUARDIAN_LIMITS.findings + 2 }, (_, i) => ({
      id: `tool-${i}`,
      type: 'tool',
      status: 'failed',
      tool: { id: 'lookup', version: 1 },
      error: { code: 'tool_error' },
    }));
    const report = guardAnswer({
      ...base,
      execution: { nodes } as unknown as Pick<Execution, 'nodes'>,
      unchecked: true,
    });
    expect(report.findings).toHaveLength(GUARDIAN_LIMITS.findings);
    expect(report.findings.at(-1)).toEqual(UNCHECKED_FINDING);
    expect(report.findings.filter((f) => f.code === 'tool_failed')).toHaveLength(
      GUARDIAN_LIMITS.findings - 1,
    );
  });

  it('is absent from a checked report, and a kept notice reads back as it was written', () => {
    expect(isUncheckedReport(guardAnswer(base))).toBe(false);
    const report = guardAnswer({ ...base, unchecked: true });
    expect(parseGuardianReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });
});
