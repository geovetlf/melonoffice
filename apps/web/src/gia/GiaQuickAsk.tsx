import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';
import { useGiaChat } from './GiaChat.js';

/**
 * Ctrl+K (⌘K on a Mac) from anywhere: a small box to ask GIA without leaving what you are doing
 * first. Sending asks through the same chat as the GIA Workplace (one GIA message, 1 credit,
 * ADR-0052) and opens the Workplace, where the answer arrives. Escape closes it; nothing is sent
 * until the person presses Enter.
 */
export function GiaQuickAsk() {
  const intl = useIntl();
  const chat = useGiaChat();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!chat.available) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      } else if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [chat.available]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  if (!open || !chat.available) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() === '' || chat.pending) return;
    chat.send(text);
    setText('');
    setOpen(false);
    navigate(paths.gia());
  };

  return (
    <div className="gia-quick" role="dialog" aria-modal="true" aria-labelledby="gia-quick-title">
      <div className="gia-quick__scrim" aria-hidden="true" onClick={() => setOpen(false)} />
      <form className="gia-quick__box" onSubmit={submit}>
        <h2 id="gia-quick-title" className="gia-quick__title">
          <FormattedMessage id="gia.quick.title" />
        </h2>
        <input
          ref={input}
          className="gia-bar__input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={intl.formatMessage({ id: 'gia.bar.placeholder' })}
          aria-label={intl.formatMessage({ id: 'gia.bar.placeholder' })}
          maxLength={2000}
        />
        <p className="gia-quick__hint">
          <FormattedMessage id="gia.quick.hint" />
        </p>
      </form>
    </div>
  );
}
