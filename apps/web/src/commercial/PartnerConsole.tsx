import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { BrandForm } from '../brand/BrandForm.js';
import { invitationLink } from '../invitations/invitationToken.js';
import type { CustomerScope } from '../partners/partnersClient.js';
import {
  ConsoleRequestError,
  type ConsoleAccount,
  type ConsoleClient,
  type ConsoleCustomer,
  type ConsoleInvitation,
  type ConsoleMember,
  type CustomerBilling,
  type CustomerSummary,
  type CustomerUsage,
  type OwnBrand,
} from './consoleClient.js';

/**
 * The partner and agency console (ADR-0090): the caller's own accounts and, inside one, its
 * customers (only what each granted), its invitations, its people and its brand. What a role may
 * change is shown from the role's name, for the screen only: the API decides every step.
 */

type Load<T> = T | 'loading' | 'error';

const SCOPES: readonly CustomerScope[] = [
  'summary',
  'usage',
  'billing',
  'branding',
  'support',
  'knowledge',
  'conversations',
];
const SENSITIVE = new Set<CustomerScope>(['knowledge', 'conversations', 'support']);
/** The modes each kind of account uses (ADR-0086). */
const MODES: Readonly<Record<ConsoleAccount['type'], readonly string[]>> = {
  partner: ['direct', 'reseller', 'white_label', 'oem', 'enterprise'],
  agency: ['agency'],
};
const ROLES: Readonly<Record<ConsoleAccount['type'], readonly string[]>> = {
  partner: ['partner.admin', 'partner.support'],
  agency: ['agency.admin', 'agency.manager'],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
};

/** A refusal as the person reads it: a message id, and the code when there is no message. */
type Failure = { readonly id: string; readonly reason?: string };

export function failureOf(error: unknown): Failure {
  if (!(error instanceof ConsoleRequestError)) return { id: 'console.errors.network' };
  if (error.code === 'invalid_commercial_request') {
    return error.field === 'email'
      ? { id: 'console.errors.email' }
      : { id: 'console.errors.invalid', reason: error.field ?? '' };
  }
  const explained =
    (error.code === undefined ? undefined : EXPLAINED[error.code]) ??
    (error.status === 403 ? 'console.errors.forbidden' : undefined);
  return explained === undefined
    ? { id: 'console.errors.other', reason: error.code ?? String(error.status) }
    : { id: explained };
}

const Failed = ({ failure }: { readonly failure: Failure | undefined }) =>
  failure === undefined ? null : (
    <p className="panel__empty" role="alert">
      <FormattedMessage id={failure.id} values={{ reason: failure.reason ?? '' }} />
    </p>
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
      <p className="panel__empty" role="alert">
        <FormattedMessage id="console.error" />
      </p>
    );
  }
  const account = accounts.find((a) => a.id === chosen) ?? accounts[0];
  return (
    <article className="dept-office partner-console">
      <h1 className="dept-office__title">
        <FormattedMessage id="console.title" />
      </h1>
      {account === undefined ? (
        <p className="panel__empty">
          <FormattedMessage id="console.none" />
        </p>
      ) : (
        <>
          {accounts.length > 1 ? (
            <AccountPicker accounts={accounts} value={account.id} onChange={setChosen} />
          ) : null}
          <p className="documents__lead">
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
    <p>
      <label htmlFor={id}>
        <FormattedMessage id="console.account" />
      </label>{' '}
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </p>
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
      <Members account={account} client={client} admin={admin} />
      <section className="dept-office__section" aria-labelledby="console-brand">
        <h2 id="console-brand">
          <FormattedMessage id="console.brand.title" />
        </h2>
        <p className="customers__meta">
          <FormattedMessage id={`console.brand.lead.${account.type}`} />
        </p>
        <BrandLevel
          load={() => client.accountBrand(account.id)}
          save={(config, version) => client.saveAccountBrand(account.id, config, version)}
          canEdit={admin}
          deps={[client, account.id]}
        />
      </section>
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
      <p className="panel__empty" role="alert">
        <FormattedMessage id="console.error" />
      </p>
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
    <section className="dept-office__section" aria-labelledby="console-customers">
      <h2 id="console-customers">
        <FormattedMessage id="console.customers.title" />
      </h2>
      {list === 'loading' ? null : list === 'error' ? (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="console.error" />
        </p>
      ) : (
        <>
          {list.customers.length === 0 ? (
            <p className="panel__empty">
              <FormattedMessage id="console.customers.none" />
            </p>
          ) : (
            <ul className="documents__list">
              {list.customers.map((c) => (
                <li key={c.organizationId} className="documents__item">
                  <span className="documents__name">
                    {c.name ?? <FormattedMessage id="console.customers.unnamed" />}
                  </span>
                  <span className="documents__meta">
                    <FormattedMessage id={`partners.mode.${c.mode}`} /> ·{' '}
                    <FormattedMessage
                      id="console.customers.scopes"
                      values={{ count: c.scopes.length }}
                    />
                  </span>
                  <Button
                    variant="secondary"
                    aria-expanded={open === c.organizationId}
                    onClick={() =>
                      setOpen(open === c.organizationId ? undefined : c.organizationId)
                    }
                  >
                    <FormattedMessage
                      id={open === c.organizationId ? 'console.close' : 'console.open'}
                    />
                  </Button>
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
            <p className="customers__meta">
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
  const partnerAdmin = admin && account.type === 'partner';
  const nothing =
    !has('summary') &&
    !has('usage') &&
    !(admin && has('billing')) &&
    !(partnerAdmin && has('branding') && customer.mode === 'white_label');
  return (
    <div className="console__customer">
      <p className="documents__meta">
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
        <div>
          <h3>
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
        <p className="panel__empty">
          <FormattedMessage id="console.customer.nothing" />
        </p>
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
    <div>
      <h3>
        <FormattedMessage id={title} />
      </h3>
      {value === 'loading' ? null : value === 'error' ? (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="console.error" />
        </p>
      ) : (
        children(value)
      )}
    </div>
  );
}

const Summary = ({ load }: { readonly load: () => Promise<CustomerSummary> }) => (
  <Part load={load} title="console.customer.summary">
    {(s) => (
      <p className="documents__meta">
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
          <p className="documents__meta">
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
            <table className="console__table">
              <thead>
                <tr>
                  <th scope="col">
                    <FormattedMessage id="console.customer.capability" />
                  </th>
                  <th scope="col">
                    <FormattedMessage id="console.customer.operations" />
                  </th>
                  <th scope="col">
                    <FormattedMessage id="console.customer.credits" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(u.byCapability).map(([capability, b]) => (
                  <tr key={capability}>
                    <td>{capability}</td>
                    <td>{intl.formatNumber(b.operations)}</td>
                    <td>{intl.formatNumber(b.credits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Part>
  );
}

const Billing = ({ load }: { readonly load: () => Promise<CustomerBilling> }) => (
  <Part load={load} title="console.customer.billing">
    {(b) => (
      <p className="documents__meta">
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
    <section className="dept-office__section" aria-labelledby="console-invitations">
      <h2 id="console-invitations">
        <FormattedMessage id="console.invitations.title" />
      </h2>
      <p className="customers__meta">
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
        <p className="panel__empty" role="alert">
          <FormattedMessage id="console.error" />
        </p>
      ) : list.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="console.invitations.none" />
        </p>
      ) : (
        <ul className="documents__list" aria-label="invitations">
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
    <div className="notice" role="status">
      <p>
        <FormattedMessage id="console.invitations.once" />
      </p>
      <label htmlFor={id} className="visually-hidden">
        <FormattedMessage id="console.invitations.link" />
      </label>
      <input id={id} readOnly value={link} onFocus={(e) => e.target.select()} />
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
        <p className="documents__meta">
          <FormattedMessage id="console.invitations.copyFailed" />
        </p>
      ) : null}
      <Button variant="secondary" onClick={onDone}>
        <FormattedMessage id="console.invitations.done" />
      </Button>
    </div>
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
  const modes = MODES[account.type];
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
    <form className="platform__form" onSubmit={(e) => void submit(e)}>
      <h3>
        <FormattedMessage id="console.invitations.new" />
      </h3>
      <label htmlFor={`${id}-email`}>
        <FormattedMessage id="auth.email" />
      </label>
      <input
        id={`${id}-email`}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      {modes.length > 1 ? (
        <>
          <label htmlFor={`${id}-mode`}>
            <FormattedMessage id="console.invitations.mode" />
          </label>
          <select id={`${id}-mode`} value={mode} onChange={(e) => setMode(e.target.value)}>
            {modes.map((m) => (
              <option key={m} value={m}>
                {intl.formatMessage({ id: `partners.mode.${m}` })}
              </option>
            ))}
          </select>
        </>
      ) : null}
      <fieldset className="partners__scopes">
        <legend>
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
            {SENSITIVE.has(scope) ? (
              <span className="documents__meta">
                {' '}
                <FormattedMessage id="console.scope.sensitive" />
              </span>
            ) : null}
          </label>
        ))}
      </fieldset>
      <Button type="submit" disabled={busy || email.trim() === ''}>
        <FormattedMessage id="console.invitations.send" />
      </Button>
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
    <li className="documents__item" aria-label={i.email}>
      <span className="documents__name">{i.email}</span>
      <span className="documents__meta">
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
      {canRevoke && i.status === 'pending' ? (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            if (
              !globalThis.confirm(
                intl.formatMessage({ id: 'console.invitation.revokeConfirm' }, { email: i.email }),
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
}: {
  readonly account: ConsoleAccount;
  readonly client: ConsoleClient;
  readonly admin: boolean;
}) {
  const intl = useIntl();
  const id = useId();
  const [list, setList] = useLoad(() => client.members(account.id), [client, account.id]);
  const roles = ROLES[account.type];
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState(roles[roles.length - 1] ?? '');
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

  return (
    <section className="dept-office__section" aria-labelledby="console-members">
      <h2 id="console-members">
        <FormattedMessage id="console.members.title" />
      </h2>
      {list === 'loading' ? null : list === 'error' ? (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="console.error" />
        </p>
      ) : (
        <ul className="documents__list" aria-label="members">
          {list
            .filter((m) => m.status !== 'revoked')
            .map((m) => (
              <li key={m.userId} className="documents__item">
                <code className="documents__name">{m.userId}</code>
                <span className="documents__meta">
                  <FormattedMessage id={`console.role.${m.role}`} />
                </span>
                {admin ? (
                  <Button
                    variant="secondary"
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
                ) : null}
              </li>
            ))}
        </ul>
      )}
      {admin ? (
        <form
          className="platform__form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              put(await client.addMember(account.id, userId.trim(), role));
              setUserId('');
            });
          }}
        >
          <h3>
            <FormattedMessage id="console.members.add" />
          </h3>
          <label htmlFor={`${id}-user`}>
            <FormattedMessage id="console.members.userId" />
          </label>
          <input
            id={`${id}-user`}
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            required
            spellCheck={false}
          />
          <label htmlFor={`${id}-role`}>
            <FormattedMessage id="console.members.role" />
          </label>
          <select id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {intl.formatMessage({ id: `console.role.${r}` })}
              </option>
            ))}
          </select>
          <Button type="submit" disabled={busy || !UUID.test(userId.trim())}>
            <FormattedMessage id="console.members.save" />
          </Button>
        </form>
      ) : null}
      <Failed failure={failed} />
    </section>
  );
}
