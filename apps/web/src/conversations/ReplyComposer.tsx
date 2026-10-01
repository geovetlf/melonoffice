import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useId, useState } from 'react';
import { newClientMessageId, type ReplyOutcome } from './sendReply.js';

export interface ReplyComposerProps {
  /** Sends the draft: see `sendReply`. The same draft keeps the same key across retries. */
  readonly onSend: (reply: {
    readonly clientMessageId: string;
    readonly text: string;
  }) => Promise<ReplyOutcome>;
  /** For tests: where new draft keys come from. */
  readonly newKey?: () => string;
  /**
   * The draft to start from, e.g. a suggested reply the person chose to use (CV-4). It is only a
   * starting text: the person edits it and sends it themselves, or not at all.
   */
  readonly initialText?: string;
}

const MAX_LENGTH = 4096;

type State = { readonly kind: 'idle' } | { readonly kind: 'sending' } | ReplyOutcome;

/**
 * The reply box of a conversation (CV-2, ADR-0034). A person writes and sends, and sees what
 * happened: sent, refused (nothing went out, with the reason), or unknown (it may have gone out,
 * and is not sent again automatically). Nothing here is sent on anyone's behalf: a suggested
 * reply (CV-4) only fills the box, and the person decides whether to send it.
 */
export function ReplyComposer({
  onSend,
  newKey = newClientMessageId,
  initialText = '',
}: ReplyComposerProps) {
  const intl = useIntl();
  const id = useId();
  const [text, setText] = useState(initialText.slice(0, MAX_LENGTH));
  const [key, setKey] = useState(newKey);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const sending = state.kind === 'sending';
  const empty = text.trim().length === 0;

  async function send() {
    if (sending || empty) return;
    setState({ kind: 'sending' });
    const outcome = await onSend({ clientMessageId: key, text });
    setState(outcome);
    // A sent or unknown message is done with: the next draft is a new message.
    if (outcome.kind !== 'refused') {
      setText('');
      setKey(newKey());
    }
  }

  return (
    <form
      className="reply"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label className="mo-label" htmlFor={id}>
        <FormattedMessage id="conversation.reply.label" />
      </label>
      <p className="mo-hint reply__who">
        <FormattedMessage id="conversation.reply.byPerson" />
      </p>
      <textarea
        id={id}
        value={text}
        maxLength={MAX_LENGTH}
        disabled={sending}
        onChange={(event) => {
          setText(event.target.value);
          // A changed draft is a different message: it gets its own key.
          if (state.kind === 'refused') setKey(newKey());
        }}
      />
      <div className="mo-form__actions">
        <Button type="submit" disabled={sending || empty}>
          {intl.formatMessage({
            id: sending ? 'conversation.reply.sending' : 'conversation.reply.send',
          })}
        </Button>
      </div>
      <p className="mo-hint reply__status" role="status" aria-live="polite">
        {state.kind === 'sent' ? <FormattedMessage id="conversation.reply.sent" /> : null}
        {state.kind === 'unknown' ? <FormattedMessage id="conversation.reply.unknown" /> : null}
        {state.kind === 'refused' ? (
          <FormattedMessage id={`conversation.reply.error.${state.code}`} />
        ) : null}
      </p>
    </form>
  );
}
