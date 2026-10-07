import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useState } from 'react';

/**
 * Workflow steps that write data (B6, ADR-0184). A tool step may change the organization's data
 * only with a tool built for it, and a person approves exactly what it writes every time a plan
 * reaches it. These helpers show what such a step writes, with a contact by its name, never its
 * id; the server checks every value again when it runs.
 */

/** A contact a person can pick for a step, by name. */
export interface ContactOption {
  readonly id: string;
  readonly name: string;
}

export type ContactsLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: readonly ContactOption[] }
  | { readonly status: 'error' };

/** The organization's contacts for a picker, loaded once; none when they cannot be read. */
export function useContacts(
  load: (() => Promise<readonly ContactOption[]>) | undefined,
): ContactsLoad | undefined {
  const [contacts, setContacts] = useState<ContactsLoad | undefined>(
    load === undefined ? undefined : { status: 'loading' },
  );
  useEffect(() => {
    if (load === undefined) return undefined;
    let live = true;
    load().then(
      (value) => live && setContacts({ status: 'ready', value }),
      () => live && setContacts({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [load]);
  return contacts;
}

/** A tool's input field label, as the editor names it; else the field's own name. */
export function fieldLabelOf(
  intl: ReturnType<typeof useIntl>,
  toolId: string,
  name: string,
): string {
  const key = `automations.editor.toolInput.${toolId}.${name}`;
  return intl.messages[key] === undefined ? name : intl.formatMessage({ id: key });
}

/** A choice of a tool's input field in words, when the tool names it; else the value itself. */
export function optionLabelOf(
  intl: ReturnType<typeof useIntl>,
  toolId: string,
  name: string,
  value: string,
): string {
  const key = `automations.editor.toolInput.${toolId}.${name}.${value}`;
  return intl.messages[key] === undefined ? value : intl.formatMessage({ id: key });
}

/** One value in words: a contact by name, a choice by its label, days as days. */
function valueText(
  intl: ReturnType<typeof useIntl>,
  toolId: string,
  name: string,
  value: unknown,
  contacts: ContactsLoad | undefined,
): string {
  if (name === 'contactId' && typeof value === 'string') {
    const found =
      contacts?.status === 'ready' ? contacts.value.find((c) => c.id === value) : undefined;
    return found?.name ?? intl.formatMessage({ id: 'automations.write.aContact' });
  }
  if (name === 'inDays' && typeof value === 'number') {
    return intl.formatMessage({ id: 'automations.write.inDays' }, { days: value });
  }
  if (typeof value === 'boolean') {
    return intl.formatMessage({ id: value ? 'automations.write.yes' : 'automations.write.no' });
  }
  if (typeof value === 'string') return optionLabelOf(intl, toolId, name, value);
  return typeof value === 'number' ? String(value) : '';
}

/**
 * What a write step will write, field by field, as the person approves it. `changesData` says it
 * changes data; a read shows its values without that warning.
 */
export function StepValues({
  toolId,
  input,
  changesData,
  contacts,
}: {
  readonly toolId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly changesData: boolean;
  readonly contacts: ContactsLoad | undefined;
}) {
  const intl = useIntl();
  const entries = Object.entries(input).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return null;
  return (
    <div className="automations__write">
      <p className="automations__meta">
        <FormattedMessage
          id={changesData ? 'automations.write.willWrite' : 'automations.write.willUse'}
        />
      </p>
      <dl className="automations__values">
        {entries.map(([name, value]) => (
          <div key={name} className="automations__value">
            <dt>{fieldLabelOf(intl, toolId, name)}</dt>
            <dd>{valueText(intl, toolId, name, value, contacts)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
