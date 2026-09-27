import { useSyncExternalStore } from 'react';

/**
 * The web app's navigation, on the browser's history API (ADR-0036). A router library is not an
 * approved dependency: `/login` is public, and the signed-in pages are named in `shell/routes.ts`
 * (ADR-0040).
 */

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  globalThis.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener('popstate', listener);
  };
}

const currentPath = () => globalThis.location.pathname;

/** The current path; the component re-renders when it changes. */
export function usePath(): string {
  return useSyncExternalStore(subscribe, currentPath, () => '/');
}

/** Only paths inside this app: never another origin (`//host`) or a scheme. */
export function isAppPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\');
}

export function navigate(path: string, { replace = false } = {}): void {
  const target = isAppPath(path) ? path : '/';
  if (target === currentPath()) return;
  if (replace) globalThis.history.replaceState(null, '', target);
  else globalThis.history.pushState(null, '', target);
  listeners.forEach((listener) => listener());
}
