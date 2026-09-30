import { PageHeader, StateMessage } from '@melonoffice/ui';
import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';
import {
  ACCEPTED_TYPES,
  contentTypeOf,
  DocumentRequestError,
  MAX_DOCUMENT_BYTES,
  type DocumentsClient,
  type DocumentView,
} from './documentsClient.js';
import { errorCode } from '../shell/errors.js';

/**
 * Documents (DOC-3): upload a file to the organization and see whether Company Brain read its
 * text (DOC-1/DOC-2, ADR-0078/0079). Everything shown is the API's record of the file; the
 * screen never reads, guesses or summarises a file's text.
 */

type Upload =
  | { readonly status: 'idle' }
  | { readonly status: 'sending'; readonly name: string }
  | { readonly status: 'done'; readonly document: DocumentView }
  | { readonly status: 'failed'; readonly code: string };

/** Error codes with their own message; any other shows the generic one. */
const UPLOAD_ERRORS: ReadonlySet<string> = new Set([
  'unsupported_type',
  'document_too_large',
  'invalid_document',
  'permission_denied',
  'storage_unavailable',
]);

const ACCEPT = [
  ...Object.keys(ACCEPTED_TYPES).map((extension) => `.${extension}`),
  ...Object.values(ACCEPTED_TYPES),
].join(',');

export function DocumentsPage({
  client,
  canUpload,
  canReadMemory = false,
}: {
  readonly client: DocumentsClient;
  readonly canUpload: boolean;
  /**
   * Whether the person can open the company memory, where what GIA read from a document waits
   * as proposals to confirm (ADR-0051, ADR-0079).
   */
  readonly canReadMemory?: boolean;
}) {
  const intl = useIntl();
  const [documents, setDocuments] = useState<readonly DocumentView[] | undefined>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [upload, setUpload] = useState<Upload>({ status: 'idle' });
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (cursor?: string) => {
      try {
        const page = await client.list(cursor);
        setDocuments((current) =>
          cursor === undefined ? page.documents : [...(current ?? []), ...page.documents],
        );
        setNextCursor(page.nextCursor);
        setLoadFailed(false);
      } catch {
        setLoadFailed(true);
      }
    },
    [client],
  );

  useEffect(() => {
    let live = true;
    client.list().then(
      (page) => {
        if (!live) return;
        setDocuments(page.documents);
        setNextCursor(page.nextCursor);
      },
      () => live && setLoadFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client]);

  async function send(file: File) {
    const contentType = contentTypeOf(file);
    if (contentType === undefined) {
      setUpload({ status: 'failed', code: 'unsupported_type' });
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setUpload({ status: 'failed', code: 'document_too_large' });
      return;
    }
    if (file.size === 0) {
      setUpload({ status: 'failed', code: 'invalid_document' });
      return;
    }
    setUpload({ status: 'sending', name: file.name });
    try {
      const document = await client.upload(file, contentType);
      setUpload({ status: 'done', document });
      await load();
    } catch (error) {
      setUpload({ status: 'failed', code: errorCode(error, DocumentRequestError, UPLOAD_ERRORS) });
    } finally {
      if (input.current !== null) input.current.value = '';
    }
  }

  async function download(document: DocumentView) {
    try {
      const blob = await client.content(document.id);
      const url = URL.createObjectURL(blob);
      const link = globalThis.document.createElement('a');
      link.href = url;
      link.download = document.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setLoadFailed(true);
    }
  }

  return (
    <article className="mo-page documents-page">
      <PageHeader
        title={<FormattedMessage id="nav.documents" />}
        description={<FormattedMessage id="documents.lead" />}
      />

      {canUpload ? (
        <section
          className="mo-panel mo-page-section documents__upload"
          aria-labelledby="doc-upload"
        >
          <h2 id="doc-upload" className="mo-section-title">
            <FormattedMessage id="documents.upload.title" />
          </h2>
          <label className="mo-field">
            <span className="mo-label">
              <FormattedMessage id="documents.upload.choose" />
            </span>
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              disabled={upload.status === 'sending'}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file !== undefined) void send(file);
              }}
            />
          </label>
          <p className="mo-hint">
            <FormattedMessage id="documents.upload.hint" />
          </p>
          {upload.status === 'sending' ? (
            <StateMessage kind="loading">
              <FormattedMessage id="documents.upload.sending" values={{ name: upload.name }} />
            </StateMessage>
          ) : upload.status === 'done' ? (
            <StateMessage kind="success">
              <FormattedMessage
                id="documents.upload.done"
                values={{ name: upload.document.name }}
              />{' '}
              <Reading document={upload.document} />
              {canReadMemory && upload.document.status === 'ingested' ? <ToMemory /> : null}
            </StateMessage>
          ) : upload.status === 'failed' ? (
            <StateMessage kind="error">
              <FormattedMessage id={`documents.error.${upload.code}`} />
            </StateMessage>
          ) : null}
        </section>
      ) : null}

      <section className="mo-panel mo-page-section" aria-labelledby="doc-list">
        <h2 id="doc-list" className="mo-section-title">
          <FormattedMessage id="documents.list.title" />
        </h2>
        {loadFailed ? (
          <StateMessage kind="error">
            <FormattedMessage id="documents.error.load" />
          </StateMessage>
        ) : null}
        {documents === undefined ? (
          loadFailed ? null : (
            <StateMessage kind="loading">
              <FormattedMessage id="documents.loading" />
            </StateMessage>
          )
        ) : documents.length === 0 ? (
          <StateMessage kind="empty">
            <FormattedMessage id="documents.none" />
          </StateMessage>
        ) : (
          <ul className="mo-list">
            {documents.map((d) => (
              <li key={d.id} className="mo-list-item">
                <div className="mo-list-item__main">
                  <span className="mo-list-item__title">{d.name}</span>
                  <span className="mo-list-item__meta">
                    {intl.formatNumber(Math.max(1, Math.round(d.sizeBytes / 1024)))} KB ·{' '}
                    {intl.formatDate(new Date(d.createdAt), { dateStyle: 'medium' })}
                  </span>
                  <span className="mo-list-item__meta">
                    <Reading document={d} />
                    {canReadMemory && d.status === 'ingested' ? <ToMemory /> : null}
                  </span>
                </div>
                <button
                  type="button"
                  className="mo-button mo-button--secondary mo-button--sm"
                  onClick={() => void download(d)}
                  aria-label={intl.formatMessage({ id: 'documents.download' }, { name: d.name })}
                >
                  <FormattedMessage id="documents.downloadShort" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {nextCursor !== null ? (
          <button
            type="button"
            className="mo-button mo-button--secondary mo-page-section__more"
            onClick={() => void load(nextCursor)}
          >
            <FormattedMessage id="documents.more" />
          </button>
        ) : null}
      </section>
    </article>
  );
}

/** Where what GIA learned from a document is reviewed and confirmed: the company memory. */
function ToMemory() {
  return (
    <>
      {' '}
      <button type="button" className="mo-link-button" onClick={() => navigate(paths.memory())}>
        <FormattedMessage id="documents.review" />
      </button>
    </>
  );
}

/** Whether Company Brain read the file's text, and how, as the API recorded it. */
function Reading({ document }: { readonly document: DocumentView }) {
  if (document.status === 'ingested') {
    return (
      <FormattedMessage
        id={`documents.read.${document.textSource ?? 'file'}`}
        values={{ pages: document.pages ?? 0, hasPages: document.pages === null ? 'no' : 'yes' }}
      />
    );
  }
  if (document.status === 'not_ingested') {
    return <FormattedMessage id={`documents.notRead.${document.ingestion ?? 'unavailable'}`} />;
  }
  return <FormattedMessage id="documents.stored" />;
}
