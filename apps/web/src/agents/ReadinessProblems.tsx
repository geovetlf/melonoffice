import { useIntl } from '@melonoffice/i18n';
import type { ReadinessProblemView } from './agentsClient.js';

/**
 * What stops an agent from working or being activated (AE-4, ADR-0115), one line each, naming
 * the skill, tool or access it is about in the person's language. The codes come from the API;
 * nothing is inferred here.
 */
export function ReadinessProblems({
  problems,
}: {
  readonly problems: readonly ReadinessProblemView[];
}) {
  const intl = useIntl();
  const message = (id: string, fallback: string) =>
    intl.messages[id] === undefined ? fallback : intl.formatMessage({ id });
  const describe = (p: ReadinessProblemView) => {
    const id = `agents.problem.${p.kind}`;
    if (intl.messages[id] === undefined) return p.kind;
    const resource = p.permission?.split('.')[0];
    return intl.formatMessage(
      { id },
      {
        skill: p.skill === undefined ? '' : message(`agents.skill.${p.skill}.name`, p.skill),
        tool: p.tool === undefined ? '' : message(`approvals.tool.${p.tool}`, p.tool),
        permission:
          resource === undefined ? '' : message(`capabilities.reads.${resource}`, resource),
      },
    );
  };
  // The same sentence once, however many records say it.
  const lines = [...new Set(problems.map(describe))];
  if (lines.length === 0) return null;
  return (
    <ul className="coming">
      {lines.map((line) => (
        <li key={line} className="coming__item">
          {line}
        </li>
      ))}
    </ul>
  );
}
