import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useBusinessSaved, useOfficeData } from '../office/OfficeData.js';
import {
  BusinessRequestError,
  EMPLOYEE_RANGES,
  SALES_CHANNELS,
  type BusinessClient,
  type BusinessProfile,
  type BusinessProfileInput,
  type BusinessType,
} from './businessClient.js';
import { currencyAfterCountryChange, startingValues } from './defaults.js';

/**
 * The business profile (ADR-0048): Settings → Business, and the onboarding step a new owner sees
 * before the Home. Name, kind of business, country, currency, city and time zone are required; the
 * rest is optional. The name is the organization's own, chosen when it was created. Only a person
 * with `organization.update` edits; everyone else who can read sees the values.
 *
 * The lists of countries, currencies and time zones come from the browser's own Intl data, and
 * the API checks every value again: the screen never decides what is valid.
 */

// Codes Intl names that are not countries or territories, as the API excludes them.
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ']);
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function countries(locale: string): readonly { code: string; name: string }[] {
  const names = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' });
  const found: { code: string; name: string }[] = [];
  for (const a of LETTERS) {
    for (const b of LETTERS) {
      const code = `${a}${b}`;
      if (NOT_COUNTRIES.has(code)) continue;
      const name = names.of(code);
      if (name !== undefined && name !== code) found.push({ code, name });
    }
  }
  return found.sort((x, y) => x.name.localeCompare(y.name, locale));
}

const supported = (key: 'currency' | 'timeZone'): readonly string[] => {
  try {
    return Intl.supportedValuesOf(key);
  } catch {
    return [];
  }
};

/** The device's time zone, offered as the starting value: the owner can change it. */
function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
}

interface Form {
  businessType: string;
  country: string;
  currency: string;
  timeZone: string;
  city: string;
  employees: string;
  salesChannels: readonly string[];
  offering: string;
  needs: string;
  notes: string;
}

function formOf(profile: BusinessProfile | null): Form {
  const start = startingValues(globalThis.navigator?.languages ?? [], deviceTimeZone());
  return {
    businessType: profile?.businessType ?? '',
    country: profile?.country ?? start.country,
    currency: profile?.currency ?? start.currency,
    timeZone: profile?.timeZone ?? start.timeZone,
    city: profile?.city ?? '',
    employees: profile?.employees ?? '',
    salesChannels: profile?.salesChannels ?? [],
    offering: profile?.offering ?? '',
    needs: profile?.needs ?? '',
    notes: profile?.notes ?? '',
  };
}

/** Only what the person filled in: an empty optional field is left out, never sent empty. */
function inputOf(form: Form): BusinessProfileInput {
  const optional = (value: string) => (value.trim() === '' ? undefined : value.trim());
  const offering = optional(form.offering);
  const needs = optional(form.needs);
  const notes = optional(form.notes);
  return {
    businessType: form.businessType,
    country: form.country,
    currency: form.currency,
    timeZone: form.timeZone,
    city: form.city.trim(),
    ...(form.employees === '' ? {} : { employees: form.employees }),
    ...(form.salesChannels.length === 0 ? {} : { salesChannels: form.salesChannels }),
    ...(offering === undefined ? {} : { offering }),
    ...(needs === undefined ? {} : { needs }),
    ...(notes === undefined ? {} : { notes }),
  };
}

type Outcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly message: string };

export function BusinessPage({
  client,
  organizationName,
  canEdit,
  onboarding = false,
}: {
  readonly client: BusinessClient;
  readonly organizationName: string;
  readonly canEdit: boolean;
  /** Shown before the Home, while the business is not described yet. */
  readonly onboarding?: boolean;
}) {
  const intl = useIntl();
  const { business } = useOfficeData();
  const saved = useBusinessSaved();
  const [types, setTypes] = useState<readonly BusinessType[] | undefined>(undefined);
  const [form, setForm] = useState<Form | undefined>(undefined);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const countryList = useMemo(() => countries(intl.locale), [intl.locale]);
  const currencies = useMemo(() => supported('currency'), []);
  const timeZones = useMemo(() => {
    const zones = supported('timeZone');
    return zones.includes('UTC') ? zones : [...zones, 'UTC'];
  }, []);
  const currencyNames = useMemo(
    () => new Intl.DisplayNames([intl.locale], { type: 'currency', fallback: 'code' }),
    [intl.locale],
  );

  useEffect(() => {
    let live = true;
    client.types().then(
      (value) => {
        if (live) setTypes(value);
      },
      () => {
        if (live) setTypes([]);
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  // The form starts from the profile the office read, and again from the one a save returned.
  const profile = business.status === 'ready' ? business.value.profile : undefined;
  const [formFor, setFormFor] = useState<BusinessProfile | null | undefined>(undefined);
  if (profile !== formFor) {
    setFormFor(profile);
    setForm(profile === undefined ? undefined : formOf(profile));
  }

  const titleId = onboarding ? 'business.onboarding.title' : 'business.title';
  const header = (
    <header className="connections__header">
      <div>
        {onboarding ? null : (
          <p className="connections__eyebrow">
            <FormattedMessage id="business.eyebrow" />
          </p>
        )}
        <h1 id="business-title">
          <FormattedMessage id={titleId} />
        </h1>
        <p>
          <FormattedMessage id={onboarding ? 'business.onboarding.intro' : 'business.intro'} />
        </p>
      </div>
    </header>
  );

  if (business.status === 'unavailable' || business.status === 'hidden') {
    return (
      <section className="connections" aria-labelledby="business-title">
        {header}
        <p className="notice notice--danger" role="alert">
          <FormattedMessage id="business.unavailable" />
        </p>
      </section>
    );
  }
  if (business.status === 'loading' || form === undefined || types === undefined) {
    return (
      <section className="connections" aria-labelledby="business-title" aria-busy="true">
        {header}
      </section>
    );
  }

  const set = (key: keyof Form, value: string | readonly string[]) => {
    setForm({ ...form, [key]: value });
    if (outcome.kind !== 'saving') setOutcome({ kind: 'idle' });
  };
  const toggleChannel = (channel: string, on: boolean) =>
    set(
      'salesChannels',
      on
        ? SALES_CHANNELS.filter((c) => c === channel || form.salesChannels.includes(c))
        : form.salesChannels.filter((c) => c !== channel),
    );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (form === undefined) return;
    setOutcome({ kind: 'saving' });
    try {
      saved(await client.save(inputOf(form)));
      setOutcome({ kind: 'saved' });
    } catch (error) {
      setOutcome({ kind: 'error', message: errorMessage(error) });
    }
  }

  function errorMessage(error: unknown): string {
    if (error instanceof BusinessRequestError) {
      if (error.code === 'invalid_profile' && error.field !== undefined) {
        const key = `business.field.${error.field}`;
        const field =
          intl.messages[key] === undefined ? error.field : intl.formatMessage({ id: key });
        return intl.formatMessage({ id: 'business.error.invalid' }, { field });
      }
      if (error.status === 409) return intl.formatMessage({ id: 'business.error.conflict' });
      if (error.status === 403) return intl.formatMessage({ id: 'business.error.denied' });
    }
    return intl.formatMessage({ id: 'business.error.failed' });
  }

  const optional = (
    <span className="connection-form__optional">
      {' '}
      <FormattedMessage id="business.optional" />
    </span>
  );
  const typeName = (type: BusinessType) =>
    intl.messages[type.nameKey] === undefined ? type.id : intl.formatMessage({ id: type.nameKey });

  return (
    <section className="connections" aria-labelledby="business-title">
      {header}
      {canEdit ? null : (
        <p className="notice">
          <FormattedMessage id="business.readOnly" />
        </p>
      )}
      <form
        className="connection-form"
        onSubmit={(e) => void submit(e)}
        aria-labelledby="business-title"
      >
        <fieldset disabled={!canEdit || outcome.kind === 'saving'} className="business-form">
          <label>
            <FormattedMessage id="business.field.name" />
            <input name="name" value={organizationName} readOnly />
          </label>
          <label>
            <FormattedMessage id="business.field.businessType" />
            <select
              name="businessType"
              required
              value={form.businessType}
              onChange={(e) => set('businessType', e.target.value)}
            >
              <option value="" disabled>
                {intl.formatMessage({ id: 'business.choose' })}
              </option>
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {typeName(type)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <FormattedMessage id="business.field.country" />
            <select
              name="country"
              required
              value={form.country}
              onChange={(e) =>
                setForm({
                  ...form,
                  country: e.target.value,
                  currency: currencyAfterCountryChange(form.country, e.target.value, form.currency),
                })
              }
            >
              <option value="" disabled>
                {intl.formatMessage({ id: 'business.choose' })}
              </option>
              {countryList.map(({ code, name }) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <FormattedMessage id="business.field.currency" />
            <select
              name="currency"
              required
              value={form.currency}
              onChange={(e) => set('currency', e.target.value)}
            >
              <option value="" disabled>
                {intl.formatMessage({ id: 'business.choose' })}
              </option>
              {currencies.map((code) => (
                <option key={code} value={code}>
                  {`${code} · ${currencyNames.of(code) ?? code}`}
                </option>
              ))}
            </select>
          </label>
          <label>
            <FormattedMessage id="business.field.city" />
            <input
              name="city"
              required
              maxLength={100}
              value={form.city}
              onChange={(e) => set('city', e.target.value)}
            />
          </label>
          <label>
            <FormattedMessage id="business.field.timeZone" />
            <select
              name="timeZone"
              required
              value={form.timeZone}
              onChange={(e) => set('timeZone', e.target.value)}
            >
              <option value="" disabled>
                {intl.formatMessage({ id: 'business.choose' })}
              </option>
              {(form.timeZone === '' || timeZones.includes(form.timeZone)
                ? timeZones
                : [form.timeZone, ...timeZones]
              ).map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label>
            <FormattedMessage id="business.field.employees" />
            {optional}
            <select
              name="employees"
              value={form.employees}
              onChange={(e) => set('employees', e.target.value)}
            >
              <option value="">{intl.formatMessage({ id: 'business.choose' })}</option>
              {EMPLOYEE_RANGES.map((range) => (
                <option key={range} value={range}>
                  {intl.formatMessage({ id: `business.employees.${range}` })}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="business-form__channels">
            <legend>
              <FormattedMessage id="business.field.salesChannels" />
              {optional}
            </legend>
            {SALES_CHANNELS.map((channel) => (
              <label key={channel} className="business-form__check">
                <input
                  type="checkbox"
                  name="salesChannels"
                  value={channel}
                  checked={form.salesChannels.includes(channel)}
                  onChange={(e) => toggleChannel(channel, e.target.checked)}
                />
                <FormattedMessage id={`business.channel.${channel}`} />
              </label>
            ))}
          </fieldset>
          {(['offering', 'needs', 'notes'] as const).map((key) => (
            <label key={key}>
              <FormattedMessage id={`business.field.${key}`} />
              {optional}
              <textarea
                name={key}
                maxLength={500}
                rows={3}
                value={form[key]}
                onChange={(e) => set(key, e.target.value)}
              />
            </label>
          ))}
        </fieldset>
        {outcome.kind === 'error' ? (
          <p className="notice notice--danger" role="alert">
            {outcome.message}
          </p>
        ) : null}
        {outcome.kind === 'saved' ? (
          <p className="notice" role="status">
            <FormattedMessage id="business.saved" />
          </p>
        ) : null}
        {canEdit ? (
          <div className="connection-card__actions">
            <Button type="submit" disabled={outcome.kind === 'saving'}>
              <FormattedMessage
                id={outcome.kind === 'saving' ? 'business.saving' : 'business.save'}
              />
            </Button>
          </div>
        ) : null}
      </form>
    </section>
  );
}
