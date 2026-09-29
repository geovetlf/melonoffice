import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { contentTypeOf } from './documentsClient.js';

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

const STORED = {
  id: 'doc_old',
  name: 'menu.docx',
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  sizeBytes: 4096,
  sha256: 'b'.repeat(64),
  status: 'not_ingested',
  ingestion: 'encrypted',
  knowledgeDocumentId: null,
  textSource: null,
  pages: null,
  uploadedBy: 'user_ana',
  createdAt: '2026-09-28T12:00:00.000Z',
  updatedAt: '2026-09-28T12:00:00.000Z',
};

function open(at: string, configure?: (backend: ReturnType<typeof fakeBackend>) => void) {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.push('document.read', 'document.upload');
  backend.options.documents = { org_1: [STORED] };
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const pick = (name: string, type: string, size = 2048) => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  const file = new File([new Uint8Array(size)], name, { type });
  fireEvent.change(input, { target: { files: [file] } });
};

const documentCalls = (backend: ReturnType<typeof fakeBackend>) =>
  backend.apiCalls().filter((c) => c.url.includes('/documents'));

describe('Documents (DOC-3)', () => {
  it('lists the files and says whether their text was read, from the API', async () => {
    open('/documents');
    expect(await screen.findByRole('heading', { level: 1, name: 'Documents' })).toBeTruthy();
    expect(await screen.findByText('menu.docx')).toBeTruthy();
    expect(screen.getByText('Not read: the file is password protected.')).toBeTruthy();
    const sidebar = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(sidebar).getByRole('link', { name: /Documents/ })).toBeTruthy();
  });

  it('uploads a PDF with its type and name, and shows how it was read', async () => {
    const backend = open('/documents');
    await screen.findByText('menu.docx');
    pick('Carta 2026.pdf', 'application/pdf');
    expect(await screen.findByText(/Carta 2026\.pdf uploaded\./)).toBeTruthy();
    expect(backend.uploads).toEqual([{ contentType: 'application/pdf', name: 'Carta 2026.pdf' }]);
    expect(
      (await screen.findAllByText('Text read into Company memory (3 pages).')).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByText('Carta 2026.pdf')).toBeTruthy();
  });

  it('refuses a file type or size the API would refuse, without sending it', async () => {
    const backend = open('/documents');
    await screen.findByText('menu.docx');
    pick('photo.png', 'image/png');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/This file type is not accepted/)).toBeTruthy();
    pick('big.pdf', 'application/pdf', 10 * 1024 * 1024 + 1);
    expect(await screen.findByText('The file is larger than 10 MB.')).toBeTruthy();
    expect(backend.uploads).toHaveLength(0);
  });

  it("shows the API's refusal as its own message", async () => {
    open('/documents', (b) => {
      b.options.documentUploadFails = { error: 'storage_unavailable', status: 503 };
    });
    await screen.findByText('menu.docx');
    pick('a.pdf', 'application/pdf');
    expect(
      await screen.findByText('Document storage is not available right now. Try again later.'),
    ).toBeTruthy();
  });

  it('without document.upload, lists the files but offers no upload', async () => {
    open('/documents', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => p !== 'document.upload');
    });
    await screen.findByText('menu.docx');
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('without document.read, Documents stays a coming tool and nothing is read', async () => {
    const backend = open('/documents', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => !p.startsWith('document.'));
    });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('heading', { level: 1, name: 'Documents' })).toBeNull();
    const sidebar = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(sidebar).queryByRole('link', { name: /Documents/ })).toBeNull();
    expect(documentCalls(backend)).toHaveLength(0);
  });

  it('names a file by its extension when the browser gives no type', () => {
    expect(contentTypeOf({ name: 'notes.MD', type: '' })).toBe('text/markdown');
    expect(contentTypeOf({ name: 'x.docx', type: '' })).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(contentTypeOf({ name: 'x.exe', type: 'application/octet-stream' })).toBeUndefined();
  });
});
