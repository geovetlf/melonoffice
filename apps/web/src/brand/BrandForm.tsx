import { FormattedMessage } from '@melonoffice/i18n';
import { Button, contrastRatio } from '@melonoffice/ui';
import { useId, useState, type FormEvent } from 'react';
import type { OwnBrand } from '../commercial/consoleClient.js';

/**
 * One brand level's form (ADR-0090): the fields the app shows today, its product name, its icon
 * and its main color. Every other field of the level is kept as it was. The API checks every
 * value and the version read; a color white text is not readable on is saved but not applied.
 */

const FIELDS = ['productName', 'faviconUrl', 'primaryColor'] as const;
type Field = (typeof FIELDS)[number];
const COLOR = /^#[0-9a-f]{6}$/i;

/** The API's refusal as it came: its code and, when it names one, the field. */
const reasonOf = (error: unknown) => {
  const { code, field } = (error ?? {}) as { code?: unknown; field?: unknown };
  return [code, field].filter((x) => typeof x === 'string').join(': ') || 'network';
};

export function BrandForm({
  brand,
  canEdit,
  onSave,
}: {
  readonly brand: OwnBrand;
  readonly canEdit: boolean;
  /** Saves the whole level; rejects with the API's code (and field, if any). */
  readonly onSave: (config: Readonly<Record<string, unknown>>) => Promise<OwnBrand>;
}) {
  const id = useId();
  const [current, setCurrent] = useState(brand);
  const initial = (own: OwnBrand['own']) =>
    Object.fromEntries(
      FIELDS.map((f) => [f, typeof own?.[f] === 'string' ? (own[f] as string) : '']),
    ) as Record<Field, string>;
  const [values, setValues] = useState(() => initial(brand.own));
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; reason?: string }>();

  const color = values.primaryColor.trim();
  const unreadable = COLOR.test(color) && contrastRatio('#ffffff', color) < 4.5;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setOutcome(undefined);
    // The level's other fields stay as they were; an emptied field is left out.
    const kept = Object.entries(current.own ?? {}).filter(
      ([key]) => !(FIELDS as readonly string[]).includes(key),
    );
    const edited = FIELDS.map((field) => [field, values[field].trim()] as const).filter(
      ([, value]) => value !== '',
    );
    const config = Object.fromEntries([...kept, ...edited]);
    try {
      const saved = await onSave(config);
      setCurrent(saved);
      setValues(initial(saved.own));
      setOutcome({ ok: true });
    } catch (error) {
      setOutcome({ ok: false, reason: reasonOf(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="platform__form" onSubmit={(e) => void submit(e)}>
      <fieldset disabled={!canEdit || busy} className="brand-form">
        {FIELDS.map((field) => (
          <div key={field} className="brand-form__field">
            <label htmlFor={`${id}-${field}`}>
              <FormattedMessage id={`brand.field.${field}`} />
            </label>
            <input
              id={`${id}-${field}`}
              value={values[field]}
              onChange={(e) => setValues({ ...values, [field]: e.target.value })}
              spellCheck={false}
              {...(field === 'primaryColor' ? { placeholder: '#a8431e' } : {})}
              {...(field === 'faviconUrl' ? { placeholder: 'https://' } : {})}
            />
          </div>
        ))}
        {unreadable ? (
          <p className="documents__meta" role="status">
            <FormattedMessage id="brand.unreadable" />
          </p>
        ) : null}
      </fieldset>
      {canEdit ? (
        <Button type="submit" disabled={busy}>
          <FormattedMessage id="brand.save" />
        </Button>
      ) : null}
      {outcome === undefined ? null : outcome.ok ? (
        <p role="status" className="notice">
          <FormattedMessage id="brand.saved" />
        </p>
      ) : (
        <p role="alert" className="panel__empty">
          <FormattedMessage id="brand.refused" values={{ reason: outcome.reason ?? '' }} />
        </p>
      )}
    </form>
  );
}
