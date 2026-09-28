import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useState, type FormEvent } from 'react';
import { navigate } from '../identity/router.js';
import { Icon, type IconName } from '../office/icons.js';
import { paths } from '../shell/routes.js';
import { GiaAvatar } from '../gia/GiaAvatar.js';

/**
 * GIA's place on the Home (ADR-0040). GIA is not built yet: the command bar, the attachments, the
 * voice and the quick actions are laid out, and say so when used. Nothing here calls a model or a
 * tool; when GIA exists it goes through the AI Gateway and the tool gate like everything else.
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
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setNotice(true);
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
      <button
        type="button"
        className="gia-bar__tool"
        aria-disabled="true"
        title={soon}
        aria-label={intl.formatMessage({ id: 'gia.bar.attach' })}
      >
        <Icon name="paperclip" size={18} />
      </button>
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

const QUICK_ACTIONS: readonly { readonly id: string; readonly icon: IconName }[] = [
  { id: 'document', icon: 'documents' },
  { id: 'file', icon: 'file' },
  { id: 'email', icon: 'mail' },
  { id: 'meeting', icon: 'calendar' },
  { id: 'video', icon: 'video' },
  { id: 'more', icon: 'more' },
];

/** Shortcuts to GIA's future tools. None exists yet, so each is marked as coming soon. */
export function QuickActions() {
  const intl = useIntl();
  return (
    <ul className="quick-actions" aria-label={intl.formatMessage({ id: 'home.quick.label' })}>
      {QUICK_ACTIONS.map((action) => (
        <li key={action.id}>
          <button
            type="button"
            className="quick-action"
            aria-disabled="true"
            title={intl.formatMessage({ id: 'common.soon' })}
          >
            <Icon name={action.icon} size={16} />
            <span>
              <FormattedMessage id={`home.quick.${action.id}`} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
