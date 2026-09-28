import { useEffect, useState } from 'react';

export type Load<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'error' };

/** A read keyed by what it was for: an older one shows as loading until the new one answers. */
export function useRead<T>(key: string, read: () => Promise<T>): Load<T> {
  const [state, setState] = useState<{ key: string; load: Load<T> } | undefined>();
  useEffect(() => {
    let live = true;
    read().then(
      (value) => live && setState({ key, load: { status: 'ready', value } }),
      () => live && setState({ key, load: { status: 'error' } }),
    );
    return () => {
      live = false;
    };
    // The key names the read: `read` changes with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state?.key === key ? state.load : { status: 'loading' };
}
