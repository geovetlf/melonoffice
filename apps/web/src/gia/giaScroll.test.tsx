import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

const ROW = 120;
const initialWidth = globalThis.innerWidth;

afterEach(() => {
  cleanup();
  globalThis.innerWidth = initialWidth;
});
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

async function openChat() {
  globalThis.history.replaceState(null, '', '/gia');
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.gia = {
    answer: 'Aún no hay historial suficiente para proyectarlo.',
    department: 'sales',
    screen: null,
    proposedAction: null,
    proposedFacts: 0,
    context: { facts: 1, activity: true, missing: [] },
    replayed: false,
    generatedBy: 'ai',
  };
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  const chat = await screen.findByRole('region', { name: 'Talk to GIA' });
  const log = chat.querySelector<HTMLOListElement>('ol.gia-chat__log');
  if (log === null) throw new Error('no chat log');
  return { chat, log };
}

/**
 * jsdom lays nothing out, so the log is given a height, a content height that grows with its
 * messages and a scroll position kept within them, as a browser would.
 */
function layOut(log: HTMLElement, visible: number) {
  Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => visible });
  Object.defineProperty(log, 'scrollHeight', {
    configurable: true,
    get: () => log.children.length * ROW,
  });
  // A browser keeps the scroll position between the top and the end of the content.
  let top = 0;
  Object.defineProperty(log, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, log.scrollHeight - log.clientHeight));
    },
  });
}

async function ask(chat: HTMLElement, message: string, answers: number) {
  fireEvent.change(within(chat).getByRole('textbox', { name: 'Your message to GIA' }), {
    target: { value: message },
  });
  fireEvent.click(within(chat).getByRole('button', { name: 'Send' }));
  await vi.waitFor(() => {
    expect(
      within(chat).getAllByText('Aún no hay historial suficiente para proyectarlo.'),
    ).toHaveLength(answers);
    expect(within(chat).queryByRole('status')).toBeNull();
  });
}

/** The person scrolls the log up to read earlier messages. */
function readEarlier(log: HTMLElement) {
  log.scrollTop = 0;
  fireEvent.scroll(log);
}

const atEnd = (log: HTMLElement) =>
  Math.max(0, log.scrollHeight - log.scrollTop - log.clientHeight);

describe("GIA's chat follows the newest message (forecasting UX)", () => {
  it('scrolls to a new answer when the person is at the end of the log', async () => {
    const { chat, log } = await openChat();
    layOut(log, 300);
    await ask(chat, '¿Cuánto venderemos el próximo mes?', 1);
    await ask(chat, 'Proyecta nuestras ventas de los próximos 30 días.', 2);
    expect(log.scrollHeight).toBeGreaterThan(log.clientHeight);
    expect(atEnd(log)).toBe(0);
    expect(within(chat).queryByRole('button', { name: 'New message from GIA ↓' })).toBeNull();
  });

  it('brings a person reading earlier messages back to the end when they send one', async () => {
    const { chat, log } = await openChat();
    layOut(log, 300);
    await ask(chat, 'Primera pregunta', 1);
    await ask(chat, 'Segunda pregunta', 2);
    readEarlier(log);
    await ask(chat, 'Tercera pregunta', 3);
    expect(atEnd(log)).toBe(0);
  });

  it('keeps the position of a person reading earlier messages when an answer arrives', async () => {
    const { chat, log } = await openChat();
    layOut(log, 300);
    await ask(chat, 'Primera pregunta', 1);
    await ask(chat, 'Segunda pregunta', 2);
    // The person sends, then scrolls up to read before GIA answers.
    fireEvent.change(within(chat).getByRole('textbox', { name: 'Your message to GIA' }), {
      target: { value: 'Tercera pregunta' },
    });
    fireEvent.click(within(chat).getByRole('button', { name: 'Send' }));
    readEarlier(log);
    await vi.waitFor(() =>
      expect(
        within(chat).getAllByText('Aún no hay historial suficiente para proyectarlo.'),
      ).toHaveLength(3),
    );
    expect(log.scrollTop).toBe(0);
    const latest = await within(chat).findByRole('button', { name: 'New message from GIA ↓' });
    fireEvent.click(latest);
    expect(atEnd(log)).toBe(0);
    expect(within(chat).queryByRole('button', { name: 'New message from GIA ↓' })).toBeNull();
  });

  it('works the same on a phone, where the log shows fewer messages and is scrolled by touch', async () => {
    globalThis.innerWidth = 375;
    const { chat, log } = await openChat();
    layOut(log, 180);
    await ask(chat, '¿Cuánto venderemos el próximo mes?', 1);
    expect(atEnd(log)).toBe(0);
    // A touch scroll up a little, still within reach of the end, keeps following.
    fireEvent.touchStart(log);
    log.scrollTop -= 20;
    fireEvent.scroll(log);
    fireEvent.touchEnd(log);
    await ask(chat, '¿Cuántos leads esperamos?', 2);
    expect(atEnd(log)).toBe(0);
    // Further up, reading: the next answer does not pull the person down.
    fireEvent.change(within(chat).getByRole('textbox', { name: 'Your message to GIA' }), {
      target: { value: '¿Cómo podrían evolucionar nuestras ventas?' },
    });
    fireEvent.click(within(chat).getByRole('button', { name: 'Send' }));
    fireEvent.touchStart(log);
    readEarlier(log);
    fireEvent.touchEnd(log);
    await within(chat).findByRole('button', { name: 'New message from GIA ↓' });
    expect(log.scrollTop).toBe(0);
  });

  it('stays at the end across several messages in a row', async () => {
    const { chat, log } = await openChat();
    layOut(log, 300);
    for (let i = 1; i <= 4; i++) {
      await ask(chat, `Pregunta ${i}`, i);
      expect(atEnd(log)).toBe(0);
    }
    expect(log.children.length).toBe(8);
  });
});
