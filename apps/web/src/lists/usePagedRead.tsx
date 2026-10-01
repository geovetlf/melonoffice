import { FormattedMessage } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useEffect, useState } from 'react';
import type { Load } from '../shell/useRead.js';

/** What every page of Comercial's lists carries (ADR-0061). */
export interface PageShape<I> {
  readonly items: readonly I[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface PagedRead<P> {
  /**
   * The first page's figures (counts, totals) with every item loaded so far, in order; `hasMore`
   * and `nextCursor` are the last page's.
   */
  readonly list: Load<P>;
  /** Asks for the next page. Does nothing while one is on its way or on the last page. */
  readonly more: () => void;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
}

interface State<P> {
  readonly key: string;
  readonly load: Load<P>;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
}

/**
 * A list read one page at a time, keyed by what it is for (its filter and version): a new key
 * starts again from the first page. Each "more" asks the API for the page after the last one,
 * with the cursor the API gave; nothing is added up or filtered here. An item already shown is
 * never shown twice.
 */
export function usePagedRead<I extends { readonly id: string }, P extends PageShape<I>>(
  key: string,
  read: (cursor?: string) => Promise<P>,
): PagedRead<P> {
  const [state, setState] = useState<State<P> | undefined>();
  useEffect(() => {
    let live = true;
    read().then(
      (value) =>
        live &&
        setState({ key, load: { status: 'ready', value }, loadingMore: false, moreFailed: false }),
      () =>
        live && setState({ key, load: { status: 'error' }, loadingMore: false, moreFailed: false }),
    );
    return () => {
      live = false;
    };
    // The key names the read: `read` changes with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const current = state?.key === key ? state : undefined;

  function more() {
    if (current === undefined || current.loadingMore || current.load.status !== 'ready') return;
    const shown = current.load.value;
    if (!shown.hasMore || shown.nextCursor === null) return;
    setState({ ...current, loadingMore: true, moreFailed: false });
    read(shown.nextCursor).then(
      (next) =>
        setState((now) => {
          // A read for another key (a new filter, a reload) has taken over: this page is stale.
          if (now?.key !== key || now.load.status !== 'ready') return now;
          const seen = new Set(now.load.value.items.map((i) => i.id));
          const value = {
            ...now.load.value,
            items: [...now.load.value.items, ...next.items.filter((i) => !seen.has(i.id))],
            hasMore: next.hasMore,
            nextCursor: next.nextCursor,
          };
          return { key, load: { status: 'ready', value }, loadingMore: false, moreFailed: false };
        }),
      () =>
        setState((now) =>
          now?.key === key ? { ...now, loadingMore: false, moreFailed: true } : now,
        ),
    );
  }

  return {
    list: current?.load ?? { status: 'loading' },
    more,
    loadingMore: current?.loadingMore ?? false,
    moreFailed: current?.moreFailed ?? false,
  };
}

/** "Load more" under a list, while another page follows; says so when that page failed. */
export function LoadMore<P extends PageShape<unknown>>({ read }: { readonly read: PagedRead<P> }) {
  if (read.list.status !== 'ready' || !read.list.value.hasMore) return null;
  return (
    <div className="list-more">
      {read.moreFailed ? (
        <StateMessage kind="error">
          <FormattedMessage id="lists.moreFailed" />
        </StateMessage>
      ) : null}
      <Button variant="secondary" disabled={read.loadingMore} onClick={read.more}>
        <FormattedMessage id={read.loadingMore ? 'lists.loadingMore' : 'lists.more'} />
      </Button>
    </div>
  );
}
