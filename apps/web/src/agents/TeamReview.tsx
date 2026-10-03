import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Badge, StateMessage, type BadgeTone } from '@melonoffice/ui';
import { useState } from 'react';
import type { AgentAuditView, AgentsClient, AuditFindingView } from './agentsClient.js';

/**
 * The review of the team (G-1, ADR-0131): what would make an agent's task, a workflow or a plan
 * fail, or work from instructions that disagree with the company memory, found before it runs.
 * Each finding names what it is about, what was found, how serious it is and what to do. It runs
 * when the person asks: it only reads, changes nothing and uses no credits. The sentences come
 * from the codes and figures the API gives; nothing is inferred here.
 */

const TONE: Readonly<Record<AuditFindingView['severity'], BadgeTone>> = {
  critical: 'danger',
  warning: 'warning',
  info: 'neutral',
};

type Load = AgentAuditView | 'loading' | 'error' | undefined;

export function TeamReview({ client }: { readonly client: AgentsClient }) {
  const intl = useIntl();
  const [review, setReview] = useState<Load>();
  const audit = client.audit;
  if (audit === undefined) return null;

  const run = () => {
    setReview('loading');
    audit().then(setReview, () => setReview('error'));
  };
  const message = (id: string, fallback: string): string =>
    intl.messages[id] === undefined ? fallback : intl.formatMessage({ id });
  const toolName = (key: string) => {
    const id = key.split('@')[0] ?? key;
    return message(`approvals.tool.${id}`, id);
  };
  const describe = (f: AuditFindingView): string => {
    const e = f.evidence;
    const text = (k: string) => (e[k] === undefined ? '' : String(e[k]));
    if (f.code === 'agent_not_ready') {
      const id = `agents.problem.${text('problem')}`;
      const resource = text('permission').split('.')[0] ?? '';
      return intl.messages[id] === undefined
        ? text('problem')
        : intl.formatMessage(
            { id },
            {
              skill: message(`agents.skill.${text('skill')}.name`, text('skill')),
              tool: toolName(text('tool')),
              permission: message(`capabilities.reads.${resource}`, resource),
            },
          );
    }
    const id = `agents.review.code.${f.code}`;
    if (intl.messages[id] === undefined) return f.code;
    return intl.formatMessage(
      { id },
      {
        ...Object.fromEntries(Object.entries(e).map(([k, v]) => [k, String(v)])),
        skill: message(`agents.skill.${text('skill')}.name`, text('skill')),
        tool: toolName(text('tool')),
        tools: text('tools').split(',').filter(Boolean).map(toolName).join(', '),
      },
    );
  };

  return (
    <section className="mo-panel mo-page-section" aria-labelledby="team-review-title">
      <h2 id="team-review-title" className="mo-section-title">
        <FormattedMessage id="agents.review.title" />
      </h2>
      <p className="mo-lead">
        <FormattedMessage id="agents.review.lead" />
      </p>
      <div className="mo-form__actions">
        <button
          type="button"
          className="mo-button mo-button--secondary mo-button--sm"
          disabled={review === 'loading'}
          onClick={run}
        >
          <FormattedMessage
            id={review === undefined ? 'agents.review.run' : 'agents.review.again'}
          />
        </button>
      </div>
      {review === undefined ? null : review === 'loading' ? (
        <StateMessage kind="loading">
          <FormattedMessage id="agents.review.loading" />
        </StateMessage>
      ) : review === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="agents.review.error" />
        </StateMessage>
      ) : (
        <>
          <p className="mo-hint">
            <FormattedMessage id="agents.review.summary" values={{ ...review.reviewed }} />
          </p>
          {review.skipped.map((s) => (
            <p key={s} className="mo-hint">
              <FormattedMessage id={`agents.review.skipped.${s}`} />
            </p>
          ))}
          {review.findings.length === 0 ? (
            <StateMessage kind="success">
              <FormattedMessage id="agents.review.clean" />
            </StateMessage>
          ) : (
            <ul className="mo-list">
              {review.findings.map((f, i) => (
                <li key={`${f.subject.id}-${f.code}-${i}`} className="mo-list-item">
                  <div className="mo-list-item__main">
                    <Badge tone={TONE[f.severity]}>
                      <FormattedMessage id={`agents.review.severity.${f.severity}`} />
                    </Badge>{' '}
                    <span className="mo-list-item__title">
                      <FormattedMessage
                        id={`agents.review.subject.${f.subject.type}`}
                        values={{ name: f.subject.name ?? '' }}
                      />
                    </span>
                    <span className="mo-list-item__meta">{describe(f)}</span>
                    <span className="mo-list-item__meta">
                      <FormattedMessage id={`agents.review.recommendation.${f.recommendation}`} />
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
