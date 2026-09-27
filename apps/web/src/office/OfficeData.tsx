import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type {
  BillingView,
  CreditsView,
  DepartmentView,
  OfficeClient,
  SpecialistView,
} from './officeClient.js';

/**
 * The office's real data, read once per organization and shared by the top bar, the sidebar, the
 * Home and the department offices (ADR-0040). A part the role cannot read is `hidden` (no call is
 * made); a part the API could not answer is `unavailable`. Neither is ever filled in by the screen.
 */
export type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'unavailable' }
  | { readonly status: 'hidden' };

export interface OfficeData {
  readonly departments: Loadable<readonly DepartmentView[]>;
  readonly specialists: Loadable<readonly SpecialistView[]>;
  readonly credits: Loadable<CreditsView>;
  readonly billing: Loadable<BillingView>;
}

const LOADING: OfficeData = {
  departments: { status: 'loading' },
  specialists: { status: 'loading' },
  credits: { status: 'loading' },
  billing: { status: 'loading' },
};

const OfficeDataContext = createContext<OfficeData>(LOADING);

export const useOfficeData = (): OfficeData => useContext(OfficeDataContext);

/** The value, when it is ready; otherwise an empty list. */
export const readyList = <T,>(loadable: Loadable<readonly T[]>): readonly T[] =>
  loadable.status === 'ready' ? loadable.value : [];

export function OfficeDataProvider({
  client,
  can,
  children,
}: {
  readonly client: OfficeClient;
  readonly can: (permission: string) => boolean;
  readonly children: ReactNode;
}) {
  const canDepartments = can('department.read');
  const canSpecialists = can('specialist.read');
  const canCredits = can('credits.read');
  const canBilling = can('billing.read');
  const [data, setData] = useState<OfficeData>(LOADING);

  useEffect(() => {
    let live = true;
    const load = <K extends keyof OfficeData>(
      key: K,
      allowed: boolean,
      read: () => Promise<OfficeData[K] extends Loadable<infer T> ? T : never>,
    ) => {
      if (!allowed) {
        setData((current) => ({ ...current, [key]: { status: 'hidden' } }));
        return;
      }
      setData((current) => ({ ...current, [key]: { status: 'loading' } }));
      read().then(
        (value) => {
          if (live) setData((current) => ({ ...current, [key]: { status: 'ready', value } }));
        },
        () => {
          if (live) setData((current) => ({ ...current, [key]: { status: 'unavailable' } }));
        },
      );
    };
    load('departments', canDepartments, () => client.departments());
    load('specialists', canSpecialists, () => client.specialists());
    load('credits', canCredits, () => client.credits());
    load('billing', canBilling, () => client.billing());
    return () => {
      live = false;
    };
  }, [client, canDepartments, canSpecialists, canCredits, canBilling]);

  return <OfficeDataContext.Provider value={data}>{children}</OfficeDataContext.Provider>;
}
