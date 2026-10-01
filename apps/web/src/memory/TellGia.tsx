import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useState, type FormEvent } from 'react';
import { MemoryRequestError, type MemoryClient } from './memoryClient.js';
import { errorMessage } from '../shell/errors.js';

/**
 * Teaching the company's memory (ADR-0051): a person tells GIA something about the business and
 * the facts she finds wait under "To review" as proposals, never confirmed; or MelonOffice's own
 * records (profile, customers, sales) are brought in again. Company Brain decides and records
 * everything; the screen only says what it answered.
 */

/** The most a person can write at once, as Company Brain accepts it. */
const MAX_TEXT = 4000;

type Outcome =
  | { readonly kind: 'captured'; readonly found: number }
  | { readonly kind: 'synced'; readonly changed: number }
  | { readonly kind: 'message'; readonly id: string; readonly alert: boolean };

export function TellGia({
  client,
  canCapture,
  canSync,
  onChanged,
}: {
  readonly client: MemoryClient;
  readonly canCapture: boolean;
  readonly canSync: boolean;
  readonly onChanged: () => void;
}) {
  const intl = useIntl();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'capture' | 'sync'>();
  const [outcome, setOutcome] = useState<Outcome>();

  const failed = (error: unknown): Outcome => {
    const id = errorMessage(error, MemoryRequestError, 'memory');
    return {
      kind: 'message',
      id: Object.hasOwn(intl.messages, id) ? id : 'memory.error.generic',
      alert: true,
    };
  };

  async function capture(event: FormEvent) {
    event.preventDefault();
    if (text.trim() === '' || busy !== undefined) return;
    setBusy('capture');
    setOutcome(undefined);
    try {
      const result = await client.capture(text.trim());
      if (result.extraction === 'extracted') {
        const found = result.outcomes.filter((o) => o.outcome !== 'unchanged').length;
        setOutcome({ kind: 'captured', found });
        if (found > 0) {
          setText('');
          onChanged();
        }
      } else {
        setOutcome({
          kind: 'message',
          id:
            result.extraction === 'unavailable' ? 'memory.tell.unavailable' : 'memory.tell.failed',
          alert: true,
        });
      }
    } catch (error) {
      setOutcome(failed(error));
    } finally {
      setBusy(undefined);
    }
  }

  async function sync() {
    if (busy !== undefined) return;
    setBusy('sync');
    setOutcome(undefined);
    try {
      const { changed } = await client.sync();
      setOutcome({ kind: 'synced', changed });
      if (changed > 0) onChanged();
    } catch (error) {
      setOutcome(failed(error));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="mo-panel mo-page-section memory__tell" aria-labelledby="memory-tell-title">
      <h2 id="memory-tell-title" className="mo-section-title">
        <FormattedMessage id="memory.tell.title" />
      </h2>
      {canCapture ? (
        <form onSubmit={(e) => void capture(e)} className="mo-form">
          <label className="mo-field">
            <span className="mo-label">
              <FormattedMessage id="memory.tell.label" />
            </span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={MAX_TEXT}
              rows={4}
            />
          </label>
          <p className="mo-hint">
            <FormattedMessage id="memory.tell.hint" />
          </p>
          <div className="mo-form__actions">
            <Button type="submit" disabled={text.trim() === '' || busy !== undefined}>
              <FormattedMessage
                id={busy === 'capture' ? 'memory.tell.reading' : 'memory.tell.submit'}
              />
            </Button>
          </div>
        </form>
      ) : null}
      {canSync ? (
        <div className="mo-form__actions">
          <Button variant="secondary" disabled={busy !== undefined} onClick={() => void sync()}>
            <FormattedMessage id={busy === 'sync' ? 'memory.sync.running' : 'memory.sync.submit'} />
          </Button>
          <span className="mo-hint">
            <FormattedMessage id="memory.sync.hint" />
          </span>
        </div>
      ) : null}
      {outcome === undefined ? null : outcome.kind === 'captured' ? (
        <StateMessage kind="success">
          <FormattedMessage id="memory.tell.found" values={{ count: outcome.found }} />
        </StateMessage>
      ) : outcome.kind === 'synced' ? (
        <StateMessage kind="success">
          <FormattedMessage id="memory.sync.done" values={{ count: outcome.changed }} />
        </StateMessage>
      ) : (
        // Every message here was announced as an alert, whatever its look.
        <StateMessage kind="error">
          <FormattedMessage id={outcome.id} />
        </StateMessage>
      )}
    </section>
  );
}
