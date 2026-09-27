import { catalogs, I18nProvider, pseudoLocalizeCatalog } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplyComposer } from './ReplyComposer.js';
import { sendReply, type ReplyOutcome } from './sendReply.js';

afterEach(cleanup);

function composer(outcomes: ReplyOutcome[], locale: 'en' | 'es' = 'en') {
  let keys = 0;
  const onSend = vi.fn(async () => outcomes.shift() ?? { kind: 'sent' as const });
  render(
    <I18nProvider locale={locale} messages={catalogs[locale]}>
      <ReplyComposer onSend={onSend} newKey={() => `key-${++keys}`} />
    </I18nProvider>,
  );
  const box = screen.getByRole('textbox');
  const type = (text: string) => fireEvent.change(box, { target: { value: text } });
  const submit = () => fireEvent.click(screen.getByRole('button'));
  return { onSend, box, type, submit };
}

describe('reply composer (CV-2)', () => {
  it('says a person is replying, and sends the text with its draft key', async () => {
    const c = composer([{ kind: 'sent' }]);
    expect(screen.getByText(/You are replying yourself/)).toBeTruthy();
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    c.type('Hola Ana');
    c.submit();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Sent.'));
    expect(c.onSend).toHaveBeenCalledWith({ clientMessageId: 'key-1', text: 'Hola Ana' });
    expect((c.box as HTMLTextAreaElement).value).toBe('');
  });

  it('shows why nothing was sent, and keeps the draft', async () => {
    const c = composer([{ kind: 'refused', code: 'outside_messaging_window' }]);
    c.type('Hola');
    c.submit();
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('More than 24 hours'),
    );
    expect((c.box as HTMLTextAreaElement).value).toBe('Hola');
  });

  it('shows an unknown outcome plainly, and never resends it by itself', async () => {
    const c = composer([{ kind: 'unknown' }]);
    c.type('Hola');
    c.submit();
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('could not confirm'),
    );
    expect(c.onSend).toHaveBeenCalledTimes(1);
    // The next message is a new one, with a new key.
    c.type('Otra');
    c.submit();
    await waitFor(() => expect(c.onSend).toHaveBeenCalledTimes(2));
    expect(c.onSend).toHaveBeenLastCalledWith({ clientMessageId: 'key-2', text: 'Otra' });
  });

  it('retries a refused draft under the same key, and a changed draft under a new one', async () => {
    const c = composer([
      { kind: 'refused', code: 'channel_not_available' },
      { kind: 'refused', code: 'channel_not_available' },
    ]);
    c.type('Hola');
    c.submit();
    await waitFor(() => expect(c.onSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('status').textContent).not.toBe(''));
    c.type('Hola de nuevo');
    c.submit();
    await waitFor(() => expect(c.onSend).toHaveBeenCalledTimes(2));
    expect(
      c.onSend.mock.calls.map(
        (call) => (call as unknown as [{ clientMessageId: string }])[0].clientMessageId,
      ),
    ).toEqual(['key-1', 'key-2']);
  });

  it('speaks Spanish, and has no hard-coded text', () => {
    composer([], 'es');
    expect(screen.getByText('Tu respuesta')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeTruthy();
    cleanup();
    render(
      <I18nProvider locale="en" messages={pseudoLocalizeCatalog(catalogs.en)}>
        <ReplyComposer onSend={vi.fn()} />
      </I18nProvider>,
    );
    for (const element of document.body.querySelectorAll('label, p, button')) {
      const text = element.textContent?.trim() ?? '';
      if (text !== '') expect(text, text).toMatch(/^\[.*\]$/);
    }
  });
});

describe('sendReply', () => {
  const answering = (status: number, body: unknown = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('posts only the key and the text, to the conversation', async () => {
    const request = answering(201, { message: {} });
    expect(
      await sendReply(request, 'org-1', 'conv-1', { clientMessageId: 'k', text: 'Hola' }),
    ).toEqual({
      kind: 'sent',
    });
    const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/v1/organizations/org-1/conversations/conv-1/messages');
    expect(JSON.parse(init.body as string)).toEqual({ clientMessageId: 'k', text: 'Hola' });
  });

  it('maps the answers: sent, unknown, refused with a known code, or generic', async () => {
    const reply = { clientMessageId: 'k', text: 'x' };
    expect(await sendReply(answering(200), 'o', 'c', reply)).toEqual({ kind: 'sent' });
    expect(await sendReply(answering(202), 'o', 'c', reply)).toEqual({ kind: 'unknown' });
    expect(
      await sendReply(answering(409, { error: 'outside_messaging_window' }), 'o', 'c', reply),
    ).toEqual({ kind: 'refused', code: 'outside_messaging_window' });
    expect(
      await sendReply(answering(502, { error: 'external_send_failed' }), 'o', 'c', reply),
    ).toEqual({ kind: 'refused', code: 'external_send_failed' });
    expect(await sendReply(answering(500, { error: 'boom' }), 'o', 'c', reply)).toEqual({
      kind: 'refused',
      code: 'generic',
    });
    const offline = vi.fn(async (): Promise<Response> => {
      throw new Error('offline');
    });
    expect(await sendReply(offline, 'o', 'c', reply)).toEqual({ kind: 'unknown' });
  });
});
