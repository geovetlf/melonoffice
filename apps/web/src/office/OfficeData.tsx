import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { BusinessClient, BusinessProfileView } from '../business/businessClient.js';
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
  /** The business profile (ADR-0048): what kind of business, and the order it suggests. */
  readonly business: Loadable<BusinessProfileView>;
}

const LOADING: OfficeData = {
  departments: { status: 'loading' },
  specialists: { status: 'loading' },
  credits: { status: 'loading' },
  billing: { status: 'loading' },
  business: { status: 'loading' },
};

const OfficeDataContext = createContext<OfficeData>(LOADING);
const BusinessSavedContext = createContext<(view: BusinessProfileView) => void>(() => undefined);

export const useOfficeData = (): OfficeData => useContext(OfficeDataContext);

/** Puts the profile the API returned after a save in place of the one read before. */
export const useBusinessSaved = (): ((view: BusinessProfileView) => void) =>
  useContext(BusinessSavedContext);

/**
 * The order the business profile suggests for the departments, once the business is described.
 * Before that the office keeps its usual order: nothing moves until the owner says what they do.
 */
export const departmentPriority = (business: Loadable<BusinessProfileView>): readonly string[] =>
  business.status === 'ready' && business.value.profile !== null
    ? business.value.departmentPriority
    : [];

/** The value, when it is ready; otherwise an empty list. */
export const readyList = <T,>(loadable: Loadable<readonly T[]>): readonly T[] =>
  loadable.status === 'ready' ? loadable.value : [];

export function OfficeDataProvider({
  client,
  business,
  can,
  children,
}: {
  readonly client: OfficeClient;
  readonly business?: BusinessClient;
  readonly can: (permission: string) => boolean;
  readonly children: ReactNode;
}) {
  const canDepartments = can('department.read');
  const canSpecialists = can('specialist.read');
  const canCredits = can('credits.read');
  const canBilling = can('billing.read');
  const canBusiness = can('organization.read') && business !== undefined;
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
    load('business', canBusiness, () =>
      business === undefined ? Promise.reject(new Error('no client')) : business.profile(),
    );
    return () => {
      live = false;
    };
  }, [client, business, canDepartments, canSpecialists, canCredits, canBilling, canBusiness]);

  const saved = useCallback(
    (view: BusinessProfileView) =>
      setData((current) => ({ ...current, business: { status: 'ready', value: view } })),
    [],
  );

  return (
    <BusinessSavedContext.Provider value={saved}>
      <OfficeDataContext.Provider value={data}>{children}</OfficeDataContext.Provider>
    </BusinessSavedContext.Provider>
  );
}
