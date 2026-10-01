import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useId, useState } from 'react';
import { InboxError, type AssistOperation, type AssistResult } from './inboxClient.js';

export interface AssistPanelProps {
  /** Asks the AI about the open conversation. The same key is the same request. */
  readonly onAssist: (operation: AssistOperation, requestKey: string) => Promise<AssistResult>;
  /** Puts a suggested reply in the person's reply box. It is not sent. */
  readonly onUseReply?: (text: string) => void;
  /** A department's name, for a next-steps suggestion. */
  readonly departmentName: (id: string | null) => string;
  /** For tests: where new request keys come from. */
  readonly newKey?: () => string;
}

const OPERATIONS: readonly AssistOperation[] = ['summary', 'intent', 'reply', 'next_steps'];

const ERRORS = new Set([
  'ai_unavailable',
  'ai_invalid_output',
  'ai_not_available',
  'ai_credits_insufficient',
  'ai_policy_denied',
  'ai_timeout',
  'rate_limited',
  'permission_denied',
]);

const newRequestKey = (): string => `web-${crypto.randomUUID()}`;

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'busy'; readonly operation: AssistOperation; readonly key: string }
  | {
      readonly kind: 'failed';
      readonly operation: AssistOperation;
      readonly key: string;
      readonly code: string;
    }
  | { readonly kind: 'done'; readonly operation: AssistOperation; readonly result: AssistResult };

/**
 * Assisted AI on the open conversation (CV-4, ADR-0037). A person asks for a summary, the
 * customer's intent, a suggested reply or next steps, and reads the answer, marked as generated
 * by AI. Nothing is sent, changed or assigned here: a suggested reply can be edited and put in
 * the reply box, where the person sends it themselves or not at all.
 */
export function AssistPanel({
  onAssist,
  onUseReply,
  departmentName,
  newKey = newRequestKey,
}: AssistPanelProps) {
  const intl = useIntl();
  const id = useId();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [draft, setDraft] = useState('');
  const busy = state.kind === 'busy';

  /** A new request gets a new key; trying a failed one again keeps its key, so it counts once. */
  async function ask(operation: AssistOperation, key: string) {
    if (busy) return;
    setState({ kind: 'busy', operation, key });
    try {
      const result = await onAssist(operation, key);
      if (result.type === 'reply') setDraft(result.reply);
      setState({ kind: 'done', operation, result });
    } catch (e) {
      const code = e instanceof InboxError && ERRORS.has(e.code) ? e.code : 'generic';
      setState({ kind: 'failed', operation, key, code });
    }
  }

  const list = (label: string, items: readonly string[]) =>
    items.length === 0 ? null : (
      <>
        <dt>
          <FormattedMessage id={label} />
        </dt>
        <dd>
          <ul>
            {items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </dd>
      </>
    );
  const intent = (code: string) =>
    intl.formatMessage({ id: `conversations.assist.intent.${code}` });

  function show(result: AssistResult) {
    switch (result.type) {
      case 'summary':
        return (
          <dl>
            <dt>
              <FormattedMessage id="conversations.assist.summary" />
            </dt>
            <dd>{result.summary}</dd>
            <dt>
              <FormattedMessage id="conversations.assist.intent" />
            </dt>
            <dd>{intent(result.intent)}</dd>
            {result.customerNeed === null ? null : (
              <>
                <dt>
                  <FormattedMessage id="conversations.assist.need" />
                </dt>
                <dd>{result.customerNeed}</dd>
              </>
            )}
            {list('conversations.assist.keyPoints', result.keyPoints)}
            {list(
              'conversations.assist.providedData',
              result.providedData.map((d) => `${d.label}: ${d.value}`),
            )}
            {list('conversations.assist.actionsTaken', result.actionsTaken)}
            {list('conversations.assist.missing', result.pendingInformation)}
            {list('conversations.assist.nextSteps', result.nextSteps)}
          </dl>
        );
      case 'intent':
        return (
          <dl>
            <dt>
              <FormattedMessage id="conversations.assist.intent" />
            </dt>
            <dd>{intent(result.primary)}</dd>
            {list('conversations.assist.secondary', result.secondary.map(intent))}
            {result.confidence === null ? null : (
              <>
                <dt>
                  <FormattedMessage id="conversations.assist.confidence" />
                </dt>
                <dd>{intl.formatNumber(result.confidence, { style: 'percent' })}</dd>
              </>
            )}
            {list('conversations.assist.missing', result.missingInformation)}
            {result.requiresHuman ? (
              <>
                <dt>
                  <FormattedMessage id="conversations.assist.requiresHuman" />
                </dt>
                <dd>{result.requiresHumanReason ?? ''}</dd>
              </>
            ) : null}
          </dl>
        );
      case 'next_steps':
        return (
          <dl>
            {list('conversations.assist.nextSteps', result.nextSteps)}
            {list('conversations.assist.missing', result.missingInformation)}
            {result.departmentId === null ? null : (
              <>
                <dt>
                  <FormattedMessage id="conversations.assist.department" />
                </dt>
                <dd>{departmentName(result.departmentId)}</dd>
              </>
            )}
            {result.requiresHuman ? (
              <>
                <dt>
                  <FormattedMessage id="conversations.assist.requiresHuman" />
                </dt>
                <dd />
              </>
            ) : null}
          </dl>
        );
      case 'reply':
        return (
          <>
            <label htmlFor={`${id}-reply`}>
              <FormattedMessage id="conversations.assist.suggestedReply" />
            </label>
            <textarea
              id={`${id}-reply`}
              value={draft}
              maxLength={4096}
              onChange={(event) => setDraft(event.target.value)}
            />
            {result.explanation === null ? null : <p>{result.explanation}</p>}
            {list('conversations.assist.warnings', result.warnings)}
            <div className="assist__actions">
              {onUseReply === undefined ? null : (
                <Button
                  size="sm"
                  disabled={draft.trim() === ''}
                  onClick={() => {
                    onUseReply(draft);
                    setState({ kind: 'idle' });
                  }}
                >
                  <FormattedMessage id="conversations.assist.useReply" />
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => void ask('reply', newKey())}>
                <FormattedMessage id="conversations.assist.regenerate" />
              </Button>
            </div>
          </>
        );
    }
  }

  return (
    <section className="assist" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="mo-subsection-title">
        <FormattedMessage id="conversations.assist.title" />
      </h3>
      <div className="assist__buttons">
        {OPERATIONS.map((operation) => (
          <Button
            key={operation}
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void ask(operation, newKey())}
          >
            <FormattedMessage id={`conversations.assist.action.${operation}`} />
          </Button>
        ))}
      </div>
      <div aria-live="polite">
        {state.kind === 'busy' ? (
          <StateMessage kind="loading" inline>
            <FormattedMessage id="conversations.assist.busy" />
          </StateMessage>
        ) : null}
        {state.kind === 'failed' ? (
          <StateMessage
            kind="error"
            action={
              state.code === 'ai_unavailable' ||
              state.code === 'ai_timeout' ||
              state.code === 'ai_invalid_output' ||
              state.code === 'generic' ? (
                // An answer that could not be read was still a call: trying again is a new request.
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    void ask(
                      state.operation,
                      state.code === 'ai_invalid_output' ? newKey() : state.key,
                    )
                  }
                >
                  <FormattedMessage id="conversations.retry" />
                </Button>
              ) : undefined
            }
          >
            <FormattedMessage id={`conversations.assist.error.${state.code}`} />
          </StateMessage>
        ) : null}
        {state.kind === 'done' ? (
          <article className="assist__result">
            <p className="assist__badge">
              <FormattedMessage id="conversations.assist.generated" />
            </p>
            {show(state.result)}
            <Button size="sm" variant="ghost" onClick={() => setState({ kind: 'idle' })}>
              <FormattedMessage id="conversations.assist.discard" />
            </Button>
          </article>
        ) : null}
      </div>
    </section>
  );
}
