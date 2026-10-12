import { createContext, useContext, type ReactNode } from 'react';
import type { PasskeysClient } from './passkeysClient.js';

/** The signed-in person's passkeys client (ADR-0188), for any screen that needs a confirmation. */
const PasskeysContext = createContext<PasskeysClient | undefined>(undefined);

export function PasskeysProvider({
  client,
  children,
}: {
  readonly client: PasskeysClient;
  readonly children: ReactNode;
}) {
  return <PasskeysContext.Provider value={client}>{children}</PasskeysContext.Provider>;
}

export const usePasskeys = (): PasskeysClient | undefined => useContext(PasskeysContext);
