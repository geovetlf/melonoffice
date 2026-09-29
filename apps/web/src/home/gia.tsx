import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../identity/AuthProvider.js';
import { navigate } from '../identity/router.js';
import { Icon, type IconName } from '../office/icons.js';
import { paths } from '../shell/routes.js';
import { GiaAvatar } from '../gia/GiaAvatar.js';
import { useGiaChat } from '../gia/GiaChat.js';

/**
 * GIA's place on the Home (ADR-0040). The command bar talks to GIA (ADR-0052): a message goes to
 * her chat and the conversation continues in her Workplace. Voice says it is coming; the quick
 * actions open the screens where real work is done. Nothing here runs a tool.
 */

export function GiaCard() {
  return (
    <a
      href={paths.gia()}
      className="gia-card"
      onClick={(event) => {
        event.preventDefault();
        navigate(paths.gia());
      }}
    >
      <GiaAvatar size={44} decorative className="gia-card__mark" />
      <span className="gia-card__text">
        <span className="gia-card__name">
          <FormattedMessage id="gia.name" />
        </span>
        <span className="gia-card__role">
          <FormattedMessage id="gia.role" />
        </span>
      </span>
      <span className="gia-card__go" aria-hidden="true">
        <Icon name="chevron" size={16} />
      </span>
    </a>
  );
}

export function GiaCommandBar() {
  const intl = useIntl();
  const [text, setText] = useState('');
  const [notice, setNotice] = useState(false);
  const chat = useGiaChat();
  const { state } = useAuth();
  // A file GIA should know is uploaded in Documents: its text goes to the company memory GIA
  // answers from (ADR-0079).
  const canUpload =
    state.status === 'signed_in' && state.workspace?.permissions.has('document.upload') === true;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chat.available) {
      setNotice(true);
      return;
    }
    if (text.trim() === '') return;
    chat.send(text);
    setText('');
    navigate(paths.gia());
  };
  const soon = intl.formatMessage({ id: 'common.soon' });
  return (
    <form
      className="gia-bar"
      onSubmit={submit}
      aria-label={intl.formatMessage({ id: 'gia.bar.label' })}
    >
      <span className="gia-bar__spark" aria-hidden="true">
        <Icon name="gia" size={20} />
      </span>
      <input
        className="gia-bar__input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={intl.formatMessage({ id: 'gia.bar.placeholder' })}
        aria-label={intl.formatMessage({ id: 'gia.bar.placeholder' })}
        maxLength={2000}
      />
      {canUpload ? (
        <button
          type="button"
          className="gia-bar__tool"
          aria-label={intl.formatMessage({ id: 'gia.bar.attach' })}
          title={intl.formatMessage({ id: 'gia.bar.attach' })}
          onClick={() => navigate(paths.documents())}
        >
          <Icon name="paperclip" size={18} />
        </button>
      ) : null}
      <button
        type="button"
        className="gia-bar__tool"
        aria-disabled="true"
        title={soon}
        aria-label={intl.formatMessage({ id: 'gia.bar.voice' })}
      >
        <Icon name="mic" size={18} />
      </button>
      <button
        type="submit"
        className="gia-bar__send"
        aria-label={intl.formatMessage({ id: 'gia.bar.send' })}
      >
        <Icon name="send" size={18} />
      </button>
      {notice ? (
        <p className="gia-bar__notice" role="status">
          <FormattedMessage id="gia.bar.notYet" />
        </p>
      ) : null}
    </form>
  );
}

/**
 * Shortcuts from the Home to what the office can really do, each opening the screen where it is
 * done and shown only to a person who may do it there. No shortcut to a tool that does not exist.
 */
const QUICK_ACTIONS: readonly {
  readonly id: string;
  readonly icon: IconName;
  readonly path: string;
  readonly anyOf: readonly string[];
}[] = [
  { id: 'file', icon: 'file', path: paths.documents(), anyOf: ['document.upload'] },
  { id: 'agentTask', icon: 'user', path: paths.agents(), anyOf: ['specialist.read'] },
  { id: 'automation', icon: 'automations', path: paths.automations(), anyOf: ['workflow.read'] },
  { id: 'teach', icon: 'memory', path: paths.memory(), anyOf: ['knowledge.read'] },
  { id: 'approvals', icon: 'check', path: paths.approvals(), anyOf: ['approval.read'] },
  { id: 'usage', icon: 'coins', path: paths.aiUsage(), anyOf: ['ai_usage.read'] },
];

export function QuickActions() {
  const intl = useIntl();
  const { state } = useAuth();
  const permissions = state.status === 'signed_in' ? state.workspace?.permissions : undefined;
  const shown = QUICK_ACTIONS.filter((a) => a.anyOf.some((p) => permissions?.has(p) === true));
  if (shown.length === 0) return null;
  return (
    <ul className="quick-actions" aria-label={intl.formatMessage({ id: 'home.quick.label' })}>
      {shown.map((action) => (
        <li key={action.id}>
          <a
            href={action.path}
            className="quick-action"
            onClick={(event) => {
              event.preventDefault();
              navigate(action.path);
            }}
          >
            <Icon name={action.icon} size={16} />
            <span>
              <FormattedMessage id={`home.quick.${action.id}`} />
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
