import { figureContradictions, type FigureFact } from '@melonoffice/brain';
import type { Execution } from '@melonoffice/domain';

/**
 * The Agent Guardian (G-2, ADR-0132): deterministic checks of a finished task's answer, before the
 * person relies on it. No model is asked and nothing is charged, so they run for every agent; the
 * optional AI review (ADR-0117) stays a separate setting of each agent. The Guardian never changes
 * the answer, never runs or undoes anything: it warns, with evidence, a severity and what to do.
 * Only a critical finding (a figure that disagrees with a fact a person confirmed) fails the
 * task's verification, like a failed AI review.
 */

export const GUARDIAN_NODE = 'guardian';

export type GuardianSeverity = 'info' | 'warning' | 'critical';

export type GuardianCode =
  /** A figure in the answer disagrees with Company Brain. */
  | 'figure_contradiction'
  /** The answer says something was done (sent, scheduled…) and no step of the task did it. */
  | 'unsupported_completion'
  /** A tool the agent used during the task failed. */
  | 'tool_failed'
  /** The agent said what it still needs from the person. */
  | 'missing_information';

export type GuardianRecommendation =
  'check_figure' | 'confirm_before_acting' | 'review_tool_error' | 'provide_missing_data';

export interface GuardianFinding {
  readonly code: GuardianCode;
  readonly severity: GuardianSeverity;
  /** Plain values only: codes, ids, figures as written, counts. */
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
  readonly recommendation: GuardianRecommendation;
}

export interface GuardianReport {
  readonly findings: readonly GuardianFinding[];
}

export const GUARDIAN_LIMITS = Object.freeze({ findings: 10, evidenceText: 120 });

const SEVERITY_ORDER: readonly GuardianSeverity[] = ['critical', 'warning', 'info'];

const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Claims, in Spanish or English, that something outside the answer was already done. Only past or
 * perfect forms of actions an agent cannot take without a step of its task: never a proposal
 * ("puedo enviar", "I can schedule") or a question.
 */
const COMPLETION_CLAIMS: readonly RegExp[] = [
  /\b(?:he|hemos|ya|ha|han)\s+(?:sido\s+)?(?:enviado|mandado|agendado|programado|reservado|cancelado|cobrado|pagado|publicado|registrado)\b/,
  /\b(?:queda|quedo|quedaron)\s+(?:ya\s+)?(?:enviad|agendad|programad|reservad|cancelad|cobrad|publicad)[oa]s?\b/,
  /\b(?:ya\s+)?(?:envie|agende|programe|reserve|cancele|cobre|publique)\b/,
  /\bi(?:'ve|\s+have)?\s+(?:already\s+)?(?:sent|scheduled|booked|cancelled|canceled|charged|emailed|published|posted)\b/,
  /\b(?:has|have)\s+been\s+(?:sent|scheduled|booked|cancelled|canceled|charged|emailed|published|posted)\b/,
];

/** The sentence of `text` that claims something was done, as written, or undefined. */
export function completionClaim(text: string): string | undefined {
  for (const sentence of text.split(/(?<=[.!?\n])/)) {
    const folded = fold(sentence);
    // A question claims nothing.
    if (folded.includes('?')) continue;
    if (COMPLETION_CLAIMS.some((pattern) => pattern.test(folded))) {
      const trimmed = sentence.trim();
      return [...trimmed].length > GUARDIAN_LIMITS.evidenceText
        ? `${[...trimmed].slice(0, GUARDIAN_LIMITS.evidenceText - 1).join('')}…`
        : trimmed;
    }
  }
  return undefined;
}

export interface GuardianFacts {
  readonly answer: string;
  readonly missing: readonly string[];
  readonly execution: Pick<Execution, 'nodes'>;
  /** Company Brain's figures the agent's department may read. Absent: not compared. */
  readonly figures?: readonly FigureFact[];
  /** Whether a tool version changes something (from the tool catalogue). Unknown counts as yes. */
  readonly mutating: (id: string, version: number) => boolean;
}

/** The Guardian's findings on one answer, most serious first, at most `GUARDIAN_LIMITS.findings`. */
export function guardAnswer(facts: GuardianFacts): GuardianReport {
  const findings: GuardianFinding[] = [];
  const tools = facts.execution.nodes.filter((n) => n.type === 'tool' && n.tool !== undefined);

  for (const c of figureContradictions(facts.answer, facts.figures ?? [])) {
    findings.push({
      code: 'figure_contradiction',
      severity: c.confirmed ? 'critical' : 'warning',
      evidence: {
        fact: c.factId,
        label: c.label,
        recorded: c.recorded,
        stated: c.stated,
        confirmed: c.confirmed,
      },
      recommendation: 'check_figure',
    });
  }

  const acted = tools.some(
    (n) =>
      n.status === 'completed' && n.tool !== undefined && facts.mutating(n.tool.id, n.tool.version),
  );
  const claim = acted ? undefined : completionClaim(facts.answer);
  if (claim !== undefined) {
    findings.push({
      code: 'unsupported_completion',
      severity: 'warning',
      evidence: { claim },
      recommendation: 'confirm_before_acting',
    });
  }

  for (const node of tools) {
    if (node.status !== 'failed' || node.tool === undefined) continue;
    findings.push({
      code: 'tool_failed',
      severity: 'warning',
      evidence: {
        step: node.id,
        tool: `${node.tool.id}@${node.tool.version}`,
        error: node.error?.code ?? 'unknown',
      },
      recommendation: 'review_tool_error',
    });
  }

  if (facts.missing.length > 0) {
    findings.push({
      code: 'missing_information',
      severity: 'info',
      evidence: { items: facts.missing.length },
      recommendation: 'provide_missing_data',
    });
  }

  const sorted = findings
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
    .slice(0, GUARDIAN_LIMITS.findings)
    .map((f) => Object.freeze({ ...f, evidence: Object.freeze({ ...f.evidence }) }));
  return Object.freeze({ findings: Object.freeze(sorted) });
}

const CODES: ReadonlySet<string> = new Set([
  'figure_contradiction',
  'unsupported_completion',
  'tool_failed',
  'missing_information',
]);
const SEVERITIES: ReadonlySet<string> = new Set(SEVERITY_ORDER);
const RECOMMENDATIONS: ReadonlySet<string> = new Set([
  'check_figure',
  'confirm_before_acting',
  'review_tool_error',
  'provide_missing_data',
]);

const isPlain = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** A kept report, checked: anything else is no report. */
export function parseGuardianReport(output: unknown): GuardianReport | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const { findings } = output as { findings?: unknown };
  if (!Array.isArray(findings)) return undefined;
  const read: GuardianFinding[] = [];
  for (const f of findings as unknown[]) {
    if (typeof f !== 'object' || f === null) return undefined;
    const { code, severity, evidence, recommendation } = f as Record<string, unknown>;
    if (
      !CODES.has(code as string) ||
      !SEVERITIES.has(severity as string) ||
      !RECOMMENDATIONS.has(recommendation as string) ||
      typeof evidence !== 'object' ||
      evidence === null ||
      !Object.values(evidence).every(isPlain)
    ) {
      return undefined;
    }
    read.push({
      code: code as GuardianCode,
      severity: severity as GuardianSeverity,
      evidence: evidence as GuardianFinding['evidence'],
      recommendation: recommendation as GuardianRecommendation,
    });
  }
  return { findings: read };
}

/** The most serious finding a person should hear about: warning or critical, never info. */
export function guardianWarningOf(report: GuardianReport): GuardianFinding | undefined {
  return report.findings.find((f) => f.severity !== 'info');
}
