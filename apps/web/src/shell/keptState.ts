import { useCallback, useState, useSyncExternalStore } from 'react';

/**
 * State that outlives the component showing it: a page is unmounted on every navigation, but what
 * the person already confirmed there (a task sent, a draft saved) and the key that makes a retry
 * the same request must still be there when they come back. The holder (GIA's chat) owns the store
 * for as long as it keeps the entries; an answer that arrives after the person left is kept too.
 */
export interface KeptStore {
  get(key: string): unknown;
  /** Stores a first value without notifying anyone: for a value created while rendering. */
  ensure<T>(key: string, create: () => T): T;
  set(key: string, value: unknown): void;
  subscribe(key: string, listener: () => void): () => void;
}

export function createKeptStore(): KeptStore {
  const values = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (key) => values.get(key),
    ensure<T>(key: string, create: () => T): T {
      if (!values.has(key)) values.set(key, create());
      return values.get(key) as T;
    },
    set(key, value) {
      values.set(key, value);
      for (const listener of listeners.get(key) ?? []) listener();
    },
    subscribe(key, listener) {
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },
  };
}

const NO_STORE = () => () => undefined;

/**
 * Like `useState`, but kept in `store` under `key` when there is one: a remounted component reads
 * what it had, and a value set after it unmounted. Without a store it is plain component state.
 */
export function useKept<T>(
  store: KeptStore | undefined,
  key: string,
  initial: () => T,
): readonly [T, (value: T) => void] {
  const [local, setLocal] = useState<T>(() =>
    store === undefined ? initial() : store.ensure(key, initial),
  );
  const subscribe = useCallback(
    (listener: () => void) => (store === undefined ? NO_STORE() : store.subscribe(key, listener)),
    [store, key],
  );
  const kept = useSyncExternalStore(subscribe, () => store?.get(key));
  const set = useCallback(
    (value: T) => {
      if (store === undefined) setLocal(value);
      else store.set(key, value);
    },
    [store, key],
  );
  return [store === undefined || kept === undefined ? local : (kept as T), set];
}
