import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, DataTable, FormSection, PageHeader, StateMessage, Toolbar } from '@melonoffice/ui';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { BrandForm } from '../brand/BrandForm.js';
import { invitationLink, joinLink } from '../invitations/invitationToken.js';
import type { CustomerScope } from '../partners/partnersClient.js';
import {
  ConsoleRequestError,
  type ConsoleAccount,
  type ConsoleClient,
  type ConsoleCustomer,
  type ConsoleInvitation,
  type ConsoleMember,
  type ConsoleMemberInvitation,
  type ConsoleReseller,
  type CustomerBilling,
  type CustomerSummary,
  type CustomerUsage,
  type OwnBrand,
} from './consoleClient.js';
import { REAUTHENTICATION_REQUIRED, SignInAgain } from '../identity/SignInAgain.js';

/**
 * The partner and agency console (ADR-0090): the caller's own accounts and, inside one, its
 * customers (only what each granted), its invitations, its people and its brand. What a role may
 * change is shown from the role's name, for the screen only: the API decides every step.
 */

type Load<T> = T | 'loading' | 'error';

/** What a partner may ask for now (ADR-0097): each one opens a read the console shows. */
const SCOPES: readonly CustomerScope[] = ['summary', 'usage', 'billing', 'branding'];
/**
 * The modes each kind of account uses (ADR-0086, ADR-0098): a reseller under a white label sells
 * under that brand, a reseller on its own sells MelonOffice. The API checks the same rule.
 */
function modesOf(account: ConsoleAccount): readonly string[] {
  switch (account.type) {
    case 'reseller':
      return account.parentAccountId ? ['white_label'] : ['reseller'];
    case 'white_label':
      return ['white_label'];
    case 'partner':
      return ['direct', 'reseller', 'white_label', 'oem', 'enterprise'];
    case 'agency':
      return ['agency'];
  }
}
/** Whether a brand of this account reaches anyone (ADR-0098): a lone reseller sells MelonOffice. */
const hasBrand = (account: ConsoleAccount) =>
  account.type !== 'reseller' || Boolean(account.parentAccountId);
const ROLES: Readonly<Record<ConsoleAccount['type'], readonly string[]>> = {
  reseller: ['reseller.admin', 'reseller.support'],
  white_label: ['white_label.admin', 'white_label.support'],
  partner: ['partner.admin', 'partner.support'],
  agency: ['agency.admin', 'agency.manager'],
};

/** A change refused after an old sign-in (ADR-0138): shown with a way to sign in again. */
const SIGN_IN_AGAIN = 'identity.signInAgain.message';

/** The API's refusals this console explains in words; any other shows its code. */
const EXPLAINED: Readonly<Record<string, string>> = {
  invitation_exists: 'console.errors.invitation_exists',
  commercial_limit_reached: 'console.errors.limit',
  permission_denied: 'console.errors.forbidden',
  commercial_account_forbidden: 'console.errors.forbidden',
  customer_forbidden: 'console.errors.forbidden',
  invitation_not_pending: 'console.errors.not_pending',
  invitation_not_found: 'console.errors.not_found',
  commercial_conflict: 'console.errors.conflict',
  cannot_revoke_self: 'console.errors.self',
  cannot_change_own_role: 'console.errors.self',
  member_not_found: 'console.errors.not_found',
  [REAUTHENTICATION_REQUIRED]: SIGN_IN_AGAIN,
};

/** A refusal as the person reads it: a message id, and the code when there is no message. */
type Failure = { readonly id: string; readonly reason?: string };

export function failureOf(error: unknown): Failure {
  if (!(error instanceof ConsoleRequestError)) return { id: 'console.errors.network' };
  if (error.code === 'invalid_commercial_request') {
    if (error.field === 'email' || error.field === 'adminEmail')
      return { id: 'console.errors.email' };
    if (error.field === 'limits') return { id: 'console.errors.limits' };
    return { id: 'console.errors.invalid', reason: error.field ?? '' };
  }
  const explained =
    (error.code === undefined ? undefined : EXPLAINED[error.code]) ??
    (error.status === 403 ? 'console.errors.forbidden' : undefined);
  return explained === undefined
    ? { id: 'console.errors.other', reason: error.code ?? String(error.status) }
    : { id: explained };
}

const Failed = ({ failure }: { readonly failure: Failure | undefined }) =>
  failure === undefined ? null : failure.id === SIGN_IN_AGAIN ? (
    <SignInAgain />
  ) : (
    <StateMessage kind="error">
      <FormattedMessage id={failure.id} values={{ reason: failure.reason ?? '' }} />
    </StateMessage>
  );

/** The last 30 days, today included, as the API's `from` and `to` (UTC days). */
export function lastDays(now: Date, days = 30): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [value, setValue] = useState<Load<T>>('loading');
  useEffect(() => {
    let live = true;
    load().then(
      (v) => live && setValue(v),
      () => live && setValue('error'),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [value, setValue] as const;
}

export function PartnerConsole({
  client,
  origin,
  now = () => new Date(),
}: {
  readonly client: ConsoleClient;
  /** Where invitation links point: this web app's own address. */
  readonly origin: string;
  readonly now?: () => Date;
}) {
  const [accounts] = useLoad(() => client.accounts(), [client]);
  const [chosen, setChosen] = useState<string>();

  if (accounts === 'loading') return null;
  if (accounts === 'error') {
    return (
      <StateMessage kind="error">
        <FormattedMessage id="console.error" />
      </StateMessage>
    );
  }
  const account = accounts.find((a) => a.id === chosen) ?? accounts[0];
  return (
    <article className="mo-page partner-console">
      <PageHeader title={<FormattedMessage id="console.title" />} />
      {account === undefined ? (
        <StateMessage kind="empty">
          <FormattedMessage id="console.none" />
        </StateMessage>
      ) : (
        <>
          {accounts.length > 1 ? (
            <AccountPicker accounts={accounts} value={account.id} onChange={setChosen} />
          ) : null}
          <p className="mo-lead">
            <strong>{account.name}</strong> ·{' '}
            <FormattedMessage id={`partners.type.${account.type}`} /> ·{' '}
            <FormattedMessage id={`console.role.${account.role}`} />
          </p>
          <Account key={account.id} account={account} client={client} origin={origin} now={now} />
        </>
      )}
    </article>
  );
}

function AccountPicker({
  accounts,
  value,
  onChange,
}: {
  readonly accounts: readonly ConsoleAccount[];
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const id = useId();
  return (
    <Toolbar>
      <label className="mo-toolbar__label" htmlFor={id}>
        <FormattedMessage id="console.account" />
      </label>{' '}
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </Toolbar>
  );
}

function Account({
  account,
  client,
  origin,
  now,
}: {
  readonly account: ConsoleAccount;
  readonly client: ConsoleClient;
  readonly origin: string;
  readonly now: () => Date;
}) {
  const admin = account.role.endsWith('.admin');
  return (
    <>
      <Customers account={account} client={client} admin={admin} now={now} />
      <Invitations account={account} client={client} admin={admin} origin={origin} />
      {account.type === 'white_label' ? (
        <Resellers account={account} client={client} admin={admin} origin={origin} />
      ) : null}
      <Members account={account} client={client} admin={admin} origin={origin} />
      {hasBrand(account) ? (
        <section className="mo-panel mo-page-section" aria-labelledby="console-brand">
          <h2 id="console-brand" className="mo-section-title">
            <FormattedMessage id="console.brand.title" />
          </h2>
          <p className="mo-lead">
            <FormattedMessage id={`console.brand.lead.${account.type}`} />
          </p>
          <BrandLevel
            load={() => client.accountBrand(account.id)}
            save={(config, version) => client.saveAccountBrand(account.id, config, version)}
            canEdit={admin}
            deps={[client, account.id]}
          />
        </section>
      ) : null}
    </>
  );
}

/** Loads one brand level and edits it with the version read. */
function BrandLevel({
  load,
  save,
  canEdit,
  deps,
}: {
  readonly load: () => Promise<OwnBrand>;
  readonly save: (
    config: Readonly<Record<string, unknown>>,
    version: string | null,
  ) => Promise<OwnBrand>;
  readonly canEdit: boolean;
  readonly deps: readonly unknown[];
}) {
  const [brand, setBrand] = useLoad(load, deps);
  if (brand === 'loading') return null;
  if (brand === 'error') {
    return (
      <StateMessage kind="error">
        <FormattedMessage id="console.error" />
      </StateMessage>
    );
  }
  // Each save names the version last read or saved, so a stale one is refused.
  return (
    <BrandForm
      brand={brand}
      canEdit={canEdit}
      onSave={async (config) => {
        const saved = await save(config, brand.updatedAt);
        setBrand(saved);
        return saved;
      }}
    />
  );
}

// ------------------------------------------------------------------ customers

function Customers({
  account,
  client,
  admin,
  now,
}: {
  readonly account: ConsoleAccount;
  readonly client: ConsoleClient;
  readonly admin: boolean;
  readonly now: () => Date;
}) {
  const [list] = useLoad(() => client.customers(account.id), [client, account.id]);
  const [open, setOpen] = useState<string>();
  return (
    <section className="mo-panel mo-page-section" aria-labelledby="console-customers">
      <h2 id="console-customers" className="mo-section-title">
        <FormattedMessage id="console.customers.title" />
      </h2>
      {list === 'loading' ? null : list === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="console.error" />
        </StateMessage>
      ) : (
        <>
          {list.customers.length === 0 ? (
            <StateMessage kind="empty">
              <FormattedMessage id="console.customers.none" />
            </StateMessage>
          ) : (
            <ul className="mo-list">
              {list.customers.map((c) => (
                <li key={c.organizationId} className="mo-list-item">
                  <div className="mo-list-item__main">
                    <span className="mo-list-item__title">
                      {c.name ?? <FormattedMessage id="console.customers.unnamed" />}
                    </span>
                    <span className="mo-list-item__meta">
                      <FormattedMessage id={`partners.mode.${c.mode}`} /> ·{' '}
                      <FormattedMessage
                        id="console.customers.scopes"
                        values={{ count: c.scopes.length }}
                      />
                    </span>
                  </div>
                  <div className="mo-list-item__actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-expanded={open === c.organizationId}
                      onClick={() =>
                        setOpen(open === c.organizationId ? undefined : c.organizationId)
                      }
                    >
                      <FormattedMessage
                        id={open === c.organizationId ? 'console.close' : 'console.open'}
                      />
                    </Button>
                  </div>
                  {open === c.organizationId ? (
                    <CustomerPanel
                      account={account}
                      customer={c}
                      client={client}
                      admin={admin}
                      now={now}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {list.pending.length > 0 ? (
            <p className="mo-hint">
              <FormattedMessage
                id="console.customers.pending"
                values={{ count: list.pending.length }}
              />
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/** One customer, as far as it granted: each part asks the API, which checks the scope again. */
function CustomerPanel({
  account,
  customer,
  client,
  admin,
  now,
}: {
  readonly account: ConsoleAccount;
  readonly customer: ConsoleCustomer;
  readonly client: ConsoleClient;
  readonly admin: boolean;
  readonly now: () => Date;
}) {
  const has = (s: CustomerScope) => customer.scopes.includes(s);
  const org = customer.organizationId;
  const partnerAdmin = admin && modesOf(account).includes('white_label');
  const nothing =
    !has('summary') &&
    !has('usage') &&
    !(admin && has('billing')) &&
    !(partnerAdmin && has('branding') && customer.mode === 'white_label');
  return (
    <div className="console__customer">
      <p className="mo-list-item__meta">
        <FormattedMessage id="console.customers.granted" />{' '}
        {customer.scopes.length === 0 ? (
          <FormattedMessage id="partners.noScopes" />
        ) : (
          customer.scopes.map((s, i) => (
            <span key={s}>
              {i === 0 ? '' : ', '}
              <FormattedMessage id={`partners.scope.${s}`} />
            </span>
          ))
        )}
      </p>
      {has('summary') ? <Summary load={() => client.summary(account.id, org)} /> : null}
      {has('usage') ? (
        <Usage
          load={() => {
            const { from, to } = lastDays(now());
            return client.usage(account.id, org, from, to);
          }}
        />
      ) : null}
      {admin && has('billing') ? <Billing load={() => client.billing(account.id, org)} /> : null}
      {partnerAdmin && has('branding') && customer.mode === 'white_label' ? (
        <div className="console__part">
          <h3 className="mo-subsection-title">
            <FormattedMessage id="console.customer.brand" />
          </h3>
          <BrandLevel
            load={() => client.customerBrand(account.id, org)}
            save={(config, version) => client.saveCustomerBrand(account.id, org, config, version)}
            canEdit
            deps={[client, account.id, org]}
          />
        </div>
      ) : null}
      {nothing ? (
        <StateMessage kind="empty" inline>
          <FormattedMessage id="console.customer.nothing" />
        </StateMessage>
      ) : null}
    </div>
  );
}

function Part<T>({
  load,
  title,
  children,
}: {
  readonly load: () => Promise<T>;
  readonly title: string;
  readonly children: (value: T) => ReactNode;
}) {
  const [value] = useLoad(load, []);
  return (
    <div className="console__part">
      <h3 className="mo-subsection-title">
        <FormattedMessage id={title} />
      </h3>
      {value === 'loading' ? null : value === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="console.error" />
        </StateMessage>
      ) : (
        children(value)
      )}
    </div>
  );
}

const Summary = ({ load }: { readonly load: () => Promise<CustomerSummary> }) => (
  <Part load={load} title="console.customer.summary">
    {(s) => (
      <p className="mo-list-item__meta">
        {s.organization.name} · {s.organization.status} ·{' '}
        {s.plan ?? <FormattedMessage id="console.customer.noPlan" />}
      </p>
    )}
  </Part>
);

function Usage({ load }: { readonly load: () => Promise<CustomerUsage> }) {
  const intl = useIntl();
  return (
    <Part load={load} title="console.customer.usage">
      {(u) => (
        <>
          <p className="mo-list-item__meta">
            <FormattedMessage
              id="console.customer.usageTotals"
              values={{
                from: u.from,
                to: u.to,
                operations: intl.formatNumber(u.totals.operations),
                credits: intl.formatNumber(u.totals.credits),
              }}
            />
          </p>
          {Object.keys(u.byCapability).length === 0 ? null : (
            <DataTable label={intl.formatMessage({ id: 'console.customer.usage' })}>
              <thead>
                <tr>
                  <th scope="col">
                    <FormattedMessage id="console.customer.capability" />
                  </th>
                  <th scope="col" className="mo-table__num">
                    <FormattedMessage id="console.customer.operations" />
                  </th>
                  <th scope="col" className="mo-table__num">
                    <FormattedMessage id="console.customer.credits" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(u.byCapability).map(([capability, b]) => (
                  <tr key={capability}>
                    <th scope="row">{capability}</th>
                    <td className="mo-table__num">{intl.formatNumber(b.operations)}</td>
                    <td className="mo-table__num">{intl.formatNumber(b.credits)}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </>
      )}
    </Part>
  );
}

const Billing = ({ load }: { readonly load: () => Promise<CustomerBilling> }) => (
  <Part load={load} title="console.customer.billing">
    {(b) => (
      <p className="mo-list-item__meta">
        {b.billedTo === null ? null : (
          <>
            <FormattedMessage id={`console.billedTo.${b.billedTo}`} /> ·{' '}
          </>
        )}
        {b.subscription === null ? (
          <FormattedMessage id="console.customer.noSubscription" />
        ) : (
          <>
            {b.subscription.plan} · {b.subscription.status}
          </>
        )}
      </p>
    )}
  </Part>
);

// ------------------------------------------------------------------ invitations

function Invitations({
  account,
  client,
  admin,
  origin,
}: {
  readonly account: ConsoleAccount;
  readonly client: ConsoleClient;
  readonly admin: boolean;
  readonly origin: string;
}) {
  const [list, setList] = useLoad(() => client.invitations(account.id), [client, account.id]);
  const [link, setLink] = useState<string>();
  const add = (i: ConsoleInvitation) =>
    setList((current) => (Array.isArray(current) ? [i, ...current] : [i]));
  const replace = (i: ConsoleInvitation) =>
    setList((current) =>
      Array.isArray(current) ? current.map((x) => (x.id === i.id ? i : x)) : current,
    );
  return (
    <section className="mo-panel mo-page-section" aria-labelledby="console-invitations">
      <h2 id="console-invitations" className="mo-section-title">
        <FormattedMessage id="console.invitations.title" />
      </h2>
      <p className="mo-lead">
        <FormattedMessage id="console.invitations.lead" />
      </p>
      {admin ? (
        <InviteForm
          account={account}
          client={client}
          onSent={(invitation, token) => {
            add(invitation);
            setLink(token === undefined ? undefined : invitationLink(origin, token));
          }}
        />
      ) : null}
      {link === undefined ? null : <OnceLink link={link} onDone={() => setLink(undefined)} />}
      {list === 'loading' ? null : list === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="console.error" />
        </StateMessage>
      ) : list.length === 0 ? (
        <StateMessage kind="empty">
          <FormattedMessage id="console.invitations.none" />
        </StateMessage>
      ) : (
        <ul className="mo-list" aria-label="invitations">
          {list.map((i) => (
            <InvitationRow
              key={i.id}
              invitation={i}
              canRevoke={admin}
              revoke={() => client.revokeInvitation(account.id, i)}
              onChange={replace}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The link, shown once: the API keeps only its hash, so it cannot be shown again. */
function OnceLink({ link, onDone }: { readonly link: string; readonly onDone: () => void }) {
  const id = useId();
  const [copied, setCopied] = useState<boolean>();
  return (
    <StateMessage
      kind="success"
      action={
        <div className="console__once">
          <label htmlFor={id} className="visually-hidden">
            <FormattedMessage id="console.invitations.link" />
          </label>
          <input id={id} readOnly value={link} onFocus={(e) => e.target.select()} />
          <div className="mo-form__actions">
            <Button
              onClick={() => {
                const clipboard = globalThis.navigator?.clipboard;
                if (clipboard === undefined) {
                  setCopied(false);
                  return;
                }
                clipboard.writeText(link).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              <FormattedMessage
                id={copied === true ? 'console.invitations.copied' : 'console.invitations.copy'}
              />
            </Button>
            {copied === false ? (
              <p className="mo-hint">
                <FormattedMessage id="console.invitations.copyFailed" />
              </p>
            ) : null}
            <Button variant="secondary" onClick={onDone}>
              <FormattedMessage id="console.invitations.done" />
            </Button>
          </div>
        </div>
      }
    >
      <FormattedMessage id="console.invitations.once" />
    </StateMessage>
  );
}

function InviteForm({
  account,
  client,
  onSent,
}: {
  readonly account: ConsoleAccount;
  readonly client: ConsoleClient;
  readonly onSent: (invitation: ConsoleInvitation, token: string | undefined) => void;
}) {
  const intl = useIntl();
  const id = useId();
  const modes = modesOf(account);
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState(modes[0] ?? '');
  const [scopes, setScopes] = useState<ReadonlySet<CustomerScope>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Failure>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailed(undefined);
    try {
      const sent = await client.invite(account.id, {
        email: email.trim(),
        mode,
        // Branding only means something for a white-label customer (ADR-0087).
        scopes: SCOPES.filter((s) => scopes.has(s) && (s !== 'branding' || mode === 'white_label')),
      });
      onSent(sent.invitation, sent.token);
      setEmail('');
      setScopes(new Set());
    } catch (error) {
      setFailed(failureOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="mo-form" onSubmit={(e) => void submit(e)}>
      <FormSection title={<FormattedMessage id="console.invitations.new" />} titleAs="h3">
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-email`}>
            <FormattedMessage id="auth.email" />
          </label>
          <input
            id={`${id}-email`}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        {modes.length > 1 ? (
          <div className="mo-field">
            <label className="mo-label" htmlFor={`${id}-mode`}>
              <FormattedMessage id="console.invitations.mode" />
            </label>
            <select id={`${id}-mode`} value={mode} onChange={(e) => setMode(e.target.value)}>
              {modes.map((m) => (
                <option key={m} value={m}>
                  {intl.formatMessage({ id: `partners.mode.${m}` })}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </FormSection>
      <fieldset className="partners__scopes">
        <legend className="mo-label">
          <FormattedMessage id="console.invitations.asks" />
        </legend>
        {SCOPES.filter((scope) => scope !== 'branding' || mode === 'white_label').map((scope) => (
          <label key={scope} className="partners__scope">
            <input
              type="checkbox"
              checked={scopes.has(scope)}
              onChange={(e) => {
                const next = new Set(scopes);
                if (e.target.checked) next.add(scope);
                else next.delete(scope);
                setScopes(next);
              }}
            />{' '}
            <FormattedMessage id={`console.scope.${scope}`} />
          </label>
        ))}
      </fieldset>
      <div className="mo-form__actions">
        <Button type="submit" disabled={busy || email.trim() === ''}>
          <FormattedMessage id="console.invitations.send" />
        </Button>
      </div>
      <Failed failure={failed} />
    </form>
  );
}

function InvitationRow({
  invitation: i,
  canRevoke,
  revoke,
  onChange,
}: {
  readonly invitation: ConsoleInvitation;
  readonly canRevoke: boolean;
  readonly revoke: () => Promise<ConsoleInvitation>;
  readonly onChange: (i: ConsoleInvitation) => void;
}) {
  const intl = useIntl();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Failure>();
  const day = (iso: string) => intl.formatDate(new Date(iso), { dateStyle: 'medium' });
  return (
    <li className="mo-list-item" aria-label={i.email}>
      <div className="mo-list-item__main">
        <span className="mo-list-item__title">{i.email}</span>
        <span className="mo-list-item__meta">
          <FormattedMessage id={`partners.mode.${i.mode}`} /> ·{' '}
          <FormattedMessage id={`console.invitation.${i.status}`} /> ·{' '}
          <FormattedMessage id="console.invitation.created" values={{ date: day(i.createdAt) }} />
          {i.status === 'pending' || i.status === 'expired' ? (
            <>
              {' · '}
              <FormattedMessage
                id={
                  i.status === 'pending'
                    ? 'console.invitation.expires'
                    : 'console.invitation.expiredOn'
                }
                values={{ date: day(i.expiresAt) }}
              />
            </>
          ) : null}
        </span>
      </div>
      {canRevoke && i.status === 'pending' ? (
        <div className="mo-list-item__actions">
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (
                !globalThis.confirm(
                  intl.formatMessage(
                    { id: 'console.invitation.revokeConfirm' },
                    { email: i.email },
                  ),
                )
              ) {
                return;
              }
              setBusy(true);
              setFailed(undefined);
              revoke().then(
                (next) => {
                  onChange(next);
                  setBusy(false);
                },
                (error: unknown) => {
                  setFailed(failureOf(error));
                  setBusy(false);
                },
              );
            }}
          >
            <FormattedMessage id="console.invitation.revoke" />
          </Button>
        </div>
      ) : null}
      <Failed failure={failed} />
    </li>
  );
}

// ------------------------------------------------------------------ people

function Members({
  account,
  client,
  admin,
  origin,
}: {
  readonly account: ConsoleAccount;
  readonly client: ConsoleClient;
  readonly admin: boolean;
  readonly origin: string;
}) {
  const intl = useIntl();
  const id = useId();
  const [list, setList] = useLoad(() => client.members(account.id), [client, account.id]);
  const [invited, setInvited] = useLoad(
    () => (admin ? client.memberInvitations(account.id) : Promise.resolve([])),
    [client, account.id, admin],
  );
  const roles = ROLES[account.type];
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(roles[roles.length - 1] ?? '');
  const [link, setLink] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Failure>();

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setFailed(undefined);
    try {
      await work();
    } catch (error) {
      setFailed(failureOf(error));
    } finally {
      setBusy(false);
    }
  };
  const put = (m: ConsoleMember) =>
    setList((current) =>
      Array.isArray(current) ? [...current.filter((x) => x.userId !== m.userId), m] : [m],
    );
  const putInvitation = (i: ConsoleMemberInvitation) =>
    setInvited((current) =>
      Array.isArray(current) ? [i, ...current.filter((x) => x.id !== i.id)] : [i],
    );

  return (
    <section className="mo-panel mo-page-section" aria-labelledby="console-members">
      <h2 id="console-members" className="mo-section-title">
        <FormattedMessage id="console.members.title" />
      </h2>
      {list === 'loading' ? null : list === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="console.error" />
        </StateMessage>
      ) : (
        <ul className="mo-list" aria-label="members">
          {list
            .filter((m) => m.status !== 'revoked')
            .map((m) => (
              <li key={m.userId} className="mo-list-item">
                <div className="mo-list-item__main">
                  <code className="mo-list-item__title">{m.userId}</code>
                  <span className="mo-list-item__meta">
                    <FormattedMessage id={`console.role.${m.role}`} />
                  </span>
                </div>
                {admin ? (
                  <div className="mo-list-item__actions">
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        if (
                          !globalThis.confirm(intl.formatMessage({ id: 'console.members.confirm' }))
                        )
                          return;
                        void run(async () => {
                          await client.revokeMember(account.id, m.userId);
                          put({ ...m, status: 'revoked' });
                        });
                      }}
                    >
                      <FormattedMessage id="console.members.remove" />
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
        </ul>
      )}
      {admin ? (
        <form
          className="mo-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const sent = await client.inviteMember(account.id, { email: email.trim(), role });
              putInvitation(sent.invitation);
              setLink(joinLink(origin, sent.token));
              setEmail('');
            });
          }}
        >
          <FormSection
            title={<FormattedMessage id="console.members.invite" />}
            titleAs="h3"
            description={<FormattedMessage id="console.members.inviteLead" />}
          >
            <div className="mo-field">
              <label className="mo-label" htmlFor={`${id}-email`}>
                <FormattedMessage id="console.members.email" />
              </label>
              <input
                id={`${id}-email`}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="mo-field">
              <label className="mo-label" htmlFor={`${id}-role`}>
                <FormattedMessage id="console.members.role" />
              </label>
              <select id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value)}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {intl.formatMessage({ id: `console.role.${r}` })}
                  </option>
                ))}
              </select>
            </div>
          </FormSection>
          <div className="mo-form__actions">
            <Button type="submit" disabled={busy || email.trim() === ''}>
              <FormattedMessage id="console.members.send" />
            </Button>
          </div>
        </form>
      ) : null}
      {link === undefined ? null : <OnceLink link={link} onDone={() => setLink(undefined)} />}
      {admin && Array.isArray(invited) && invited.length > 0 ? (
        <ul className="mo-list" aria-label="member invitations">
          {invited.map((i) => (
            <li key={i.id} className="mo-list-item" aria-label={i.email}>
              <div className="mo-list-item__main">
                <span className="mo-list-item__title">{i.email}</span>
                <span className="mo-list-item__meta">
                  <FormattedMessage id={`console.role.${i.role}`} /> ·{' '}
                  <FormattedMessage id={`console.invitation.${i.status}`} />
                </span>
              </div>
              {i.status === 'pending' ? (
                <div className="mo-list-item__actions">
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (
                        !globalThis.confirm(
                          intl.formatMessage({ id: 'console.members.withdrawConfirm' }),
                        )
                      )
                        return;
                      void run(async () =>
                        putInvitation(await client.revokeMemberInvitation(account.id, i)),
                      );
                    }}
                  >
                    <FormattedMessage id="console.invitation.revoke" />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <Failed failure={failed} />
    </section>
  );
}

// ------------------------------------------------------------------ resellers

/**
 * A white label's resellers (ADR-0098): who they are, how many customers each serves and whether
 * their first admin has joined. Nothing inside their customers: each customer grants its own.
 */
function Resellers({
  account,
  client,
  admin,
  origin,
}: {
  readonly account: ConsoleAccount;
  readonly client: ConsoleClient;
  readonly admin: boolean;
  readonly origin: string;
}) {
  const intl = useIntl();
  const id = useId();
  const [list, setList] = useLoad(() => client.resellers(account.id), [client, account.id]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [customers, setCustomers] = useState('');
  const [members, setMembers] = useState('');
  const [link, setLink] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Failure>();

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setFailed(undefined);
    try {
      await work();
    } catch (error) {
      setFailed(failureOf(error));
    } finally {
      setBusy(false);
    }
  };
  const put = (r: ConsoleReseller) =>
    setList((current) =>
      typeof current === 'object'
        ? { ...current, resellers: [...current.resellers.filter((x) => x.id !== r.id), r] }
        : { resellers: [r], limit: null },
    );
  const whole = (value: string) => (/^[0-9]+$/.test(value) ? Number(value) : Number.NaN);
  const day = (iso: string) => intl.formatDate(new Date(iso), { dateStyle: 'medium' });

  return (
    <section className="mo-panel mo-page-section" aria-labelledby="console-resellers">
      <h2 id="console-resellers" className="mo-section-title">
        <FormattedMessage id="console.resellers.title" />
      </h2>
      {list === 'loading' ? null : list === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="console.error" />
        </StateMessage>
      ) : (
        <>
          <p className="mo-hint">
            <FormattedMessage
              id={list.limit === null ? 'console.resellers.noLimit' : 'console.resellers.count'}
              values={{ count: list.resellers.length, limit: list.limit ?? 0 }}
            />
          </p>
          {list.resellers.length === 0 ? (
            <StateMessage kind="empty">
              <FormattedMessage id="console.resellers.none" />
            </StateMessage>
          ) : (
            <ul className="mo-list" aria-label="resellers">
              {list.resellers.map((r) => (
                <li key={r.id} className="mo-list-item" aria-label={r.name}>
                  <div className="mo-list-item__main">
                    <span className="mo-list-item__title">{r.name}</span>
                    <span className="mo-list-item__meta">
                      <FormattedMessage id={`console.resellers.status.${r.status}`} /> ·{' '}
                      <FormattedMessage
                        id="console.resellers.customers"
                        values={{ count: r.customers }}
                      />
                      {r.pendingAdmins.map((p) => (
                        <span key={p.email}>
                          {' · '}
                          <FormattedMessage
                            id="console.resellers.pendingAdmin"
                            values={{ email: p.email, date: day(p.expiresAt) }}
                          />
                        </span>
                      ))}
                    </span>
                  </div>
                  {admin && r.status !== 'closed' ? (
                    <div className="mo-list-item__actions">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          const next = r.status === 'active' ? 'suspended' : 'active';
                          if (
                            next === 'suspended' &&
                            !globalThis.confirm(
                              intl.formatMessage(
                                { id: 'console.resellers.suspendConfirm' },
                                { name: r.name },
                              ),
                            )
                          ) {
                            return;
                          }
                          void run(async () => {
                            const saved = await client.setResellerStatus(account.id, r, next);
                            put({ ...r, ...saved });
                          });
                        }}
                      >
                        <FormattedMessage
                          id={
                            r.status === 'active'
                              ? 'console.resellers.suspend'
                              : 'console.resellers.reactivate'
                          }
                        />
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {admin && typeof list === 'object' && list.limit !== null ? (
        <form
          className="mo-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const created = await client.createReseller(account.id, {
                name: name.trim(),
                adminEmail: email.trim(),
                limits: { customers: whole(customers), members: whole(members) },
              });
              put(created.reseller);
              setLink(joinLink(origin, created.token));
              setName('');
              setEmail('');
              setCustomers('');
              setMembers('');
            });
          }}
        >
          <FormSection
            title={<FormattedMessage id="console.resellers.new" />}
            titleAs="h3"
            description={<FormattedMessage id="console.resellers.newLead" />}
          >
            <div className="mo-field">
              <label className="mo-label" htmlFor={`${id}-name`}>
                <FormattedMessage id="console.resellers.name" />
              </label>
              <input
                id={`${id}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="mo-field">
              <label className="mo-label" htmlFor={`${id}-email`}>
                <FormattedMessage id="console.resellers.adminEmail" />
              </label>
              <input
                id={`${id}-email`}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="mo-field">
              <label className="mo-label" htmlFor={`${id}-customers`}>
                <FormattedMessage id="console.resellers.maxCustomers" />
              </label>
              <input
                id={`${id}-customers`}
                type="number"
                min={1}
                max={account.limits?.customers}
                value={customers}
                onChange={(e) => setCustomers(e.target.value)}
                required
              />
            </div>
            <div className="mo-field">
              <label className="mo-label" htmlFor={`${id}-members`}>
                <FormattedMessage id="console.resellers.maxMembers" />
              </label>
              <input
                id={`${id}-members`}
                type="number"
                min={1}
                max={account.limits?.members}
                value={members}
                onChange={(e) => setMembers(e.target.value)}
                required
              />
            </div>
          </FormSection>
          <div className="mo-form__actions">
            <Button
              type="submit"
              disabled={busy || name.trim() === '' || email.trim() === '' || !customers || !members}
            >
              <FormattedMessage id="console.resellers.create" />
            </Button>
          </div>
        </form>
      ) : null}
      {link === undefined ? null : <OnceLink link={link} onDone={() => setLink(undefined)} />}
      <Failed failure={failed} />
    </section>
  );
}
