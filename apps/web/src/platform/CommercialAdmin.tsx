import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { CreditGrant } from './CreditGrant.js';
import {
  errorOf,
  type CommercialAccountStatus,
  type CommercialAccountView,
  type DomainStatus,
  type DomainView,
  type PlatformClient,
} from './platformClient.js';

/**
 * The platform administrator's commercial tools (ADR-0088): create partner and agency accounts
 * with their first admin and limits (ADR-0086, "Solo plataforma"), and register domains and move
 * them through their statuses (ADR-0087); suspend, reactivate or close an account and change its
 * limits, and add credits to an organization by hand (ADR-0091). The server decides and audits
 * every step; this only asks.
 */

type Load<T> = readonly T[] | 'loading' | 'error';

/** The next statuses the API allows; only a verified domain becomes active. */
const NEXT: Readonly<Record<DomainStatus, readonly DomainStatus[]>> = {
  pending_verification: ['verified', 'disabled'],
  verified: ['active', 'disabled'],
  active: ['disabled'],
  disabled: ['pending_verification'],
};

/** The account statuses the API allows next; closed is final. */
const ACCOUNT_NEXT: Readonly<
  Record<CommercialAccountStatus, readonly Exclude<CommercialAccountStatus, 'closed'>[]>
> = { active: ['suspended'], suspended: ['active'], closed: [] };

export function CommercialAdmin({
  client,
  currentUserId,
}: {
  readonly client: PlatformClient;
  readonly currentUserId?: string;
}) {
  const [accounts, setAccounts] = useState<Load<CommercialAccountView>>('loading');
  const [domains, setDomains] = useState<Load<DomainView>>('loading');

  useEffect(() => {
    let live = true;
    client.commercialAccounts().then(
      (list) => live && setAccounts(list),
      () => live && setAccounts('error'),
    );
    client.domains().then(
      (list) => live && setDomains(list),
      () => live && setDomains('error'),
    );
    return () => {
      live = false;
    };
  }, [client]);

  return (
    <>
      <section className="dept-office__section" aria-labelledby="platform-commercial">
        <h2 id="platform-commercial">
          <FormattedMessage id="platform.commercial.title" />
        </h2>
        <p className="customers__meta">
          <FormattedMessage id="platform.commercial.lead" />
        </p>
        {accounts === 'loading' ? null : accounts === 'error' ? (
          <p className="panel__empty" role="alert">
            <FormattedMessage id="platform.commercial.error" />
          </p>
        ) : accounts.length === 0 ? (
          <p className="panel__empty">
            <FormattedMessage id="platform.commercial.none" />
          </p>
        ) : (
          <ul className="documents__list" aria-label="accounts">
            {accounts.map((a) => (
              <AccountRow
                key={a.id}
                account={a}
                client={client}
                onChange={(next) =>
                  setAccounts((list) =>
                    Array.isArray(list) ? list.map((x) => (x.id === next.id ? next : x)) : list,
                  )
                }
              />
            ))}
          </ul>
        )}
        <NewAccount
          client={client}
          currentUserId={currentUserId}
          onCreated={(a) => setAccounts((list) => (Array.isArray(list) ? [a, ...list] : [a]))}
        />
      </section>

      <CreditGrant client={client} />

      <section className="dept-office__section" aria-labelledby="platform-domains">
        <h2 id="platform-domains">
          <FormattedMessage id="platform.domains.title" />
        </h2>
        <p className="customers__meta">
          <FormattedMessage id="platform.domains.lead" />
        </p>
        {domains === 'loading' ? null : domains === 'error' ? (
          <p className="panel__empty" role="alert">
            <FormattedMessage id="platform.domains.error" />
          </p>
        ) : domains.length === 0 ? (
          <p className="panel__empty">
            <FormattedMessage id="platform.domains.none" />
          </p>
        ) : (
          <ul className="documents__list">
            {domains.map((d) => (
              <DomainRow
                key={d.hostname}
                domain={d}
                client={client}
                onChange={(next) =>
                  setDomains((list) =>
                    Array.isArray(list)
                      ? list.map((x) => (x.hostname === next.hostname ? next : x))
                      : list,
                  )
                }
              />
            ))}
          </ul>
        )}
        <NewDomain
          client={client}
          accounts={Array.isArray(accounts) ? accounts : []}
          onCreated={(d) => setDomains((list) => (Array.isArray(list) ? [d, ...list] : [d]))}
        />
      </section>
    </>
  );
}

function AccountRow({
  account: a,
  client,
  onChange,
}: {
  readonly account: CommercialAccountView;
  readonly client: PlatformClient;
  readonly onChange: (a: CommercialAccountView) => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [closing, setClosing] = useState(false);
  const [typed, setTyped] = useState('');
  const [editing, setEditing] = useState(false);
  const [customers, setCustomers] = useState('');
  const [members, setMembers] = useState('');

  const run = async (change: () => Promise<CommercialAccountView>) => {
    setBusy(true);
    setFailed(undefined);
    try {
      onChange(await change());
      setClosing(false);
      setEditing(false);
      setTyped('');
    } catch (error) {
      setFailed(errorOf(error));
    } finally {
      setBusy(false);
    }
  };

  const status = a.status as CommercialAccountStatus;
  const open = status !== 'closed';
  return (
    <li className="documents__item" aria-label={a.name}>
      <span className="documents__name">{a.name}</span>
      <span className="documents__meta">
        <FormattedMessage id={`partners.type.${a.type}`} /> ·{' '}
        <FormattedMessage id={`platform.commercial.status.${status}`} /> ·{' '}
        <FormattedMessage
          id="platform.commercial.limits"
          values={{ customers: a.limits?.customers ?? 0, members: a.limits?.members ?? 0 }}
        />
      </span>
      <code className="documents__meta">{a.id}</code>
      {open ? (
        <div className="partners__actions">
          {(ACCOUNT_NEXT[status] ?? []).map((next) => (
            <Button
              key={next}
              variant="secondary"
              disabled={busy}
              onClick={() => void run(() => client.setAccountStatus(a, next))}
            >
              <FormattedMessage id={`platform.commercial.to.${next}`} />
            </Button>
          ))}
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setEditing((x) => !x);
              setClosing(false);
              setCustomers(String(a.limits?.customers ?? 0));
              setMembers(String(a.limits?.members ?? 1));
            }}
          >
            <FormattedMessage id="platform.commercial.editLimits" />
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setClosing((x) => !x);
              setEditing(false);
              setTyped('');
            }}
          >
            <FormattedMessage id="platform.commercial.to.closed" />
          </Button>
        </div>
      ) : null}
      {editing ? (
        <form
          className="platform__form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              client.setAccountLimits(a, {
                customers: Number(customers),
                members: Number(members),
              }),
            );
          }}
        >
          <label htmlFor={`${id}-customers`}>
            <FormattedMessage id="platform.commercial.customers" />
          </label>
          <input
            id={`${id}-customers`}
            type="number"
            min={0}
            value={customers}
            onChange={(e) => setCustomers(e.target.value)}
            required
          />
          <label htmlFor={`${id}-members`}>
            <FormattedMessage id="platform.commercial.members" />
          </label>
          <input
            id={`${id}-members`}
            type="number"
            min={1}
            value={members}
            onChange={(e) => setMembers(e.target.value)}
            required
          />
          <Button type="submit" disabled={busy}>
            <FormattedMessage id="platform.commercial.saveLimits" />
          </Button>
        </form>
      ) : null}
      {closing ? (
        <form
          className="platform__form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => client.setAccountStatus(a, 'closed', typed));
          }}
        >
          <p className="customers__meta">
            <FormattedMessage id="platform.commercial.closeWarning" />
          </p>
          <label htmlFor={`${id}-confirm`}>
            <FormattedMessage id="platform.commercial.closeConfirm" values={{ name: a.name }} />
          </label>
          <input
            id={`${id}-confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" disabled={busy || typed !== a.name}>
            <FormattedMessage id="platform.commercial.closeForGood" />
          </Button>
        </form>
      ) : null}
      {failed === undefined ? null : (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="platform.refused" values={{ reason: failed }} />
        </p>
      )}
    </li>
  );
}

function NewAccount({
  client,
  currentUserId,
  onCreated,
}: {
  readonly client: PlatformClient;
  readonly currentUserId: string | undefined;
  readonly onCreated: (a: CommercialAccountView) => void;
}) {
  const intl = useIntl();
  const id = useId();
  const [type, setType] = useState<'partner' | 'agency'>('partner');
  const [name, setName] = useState('');
  const [admin, setAdmin] = useState('');
  const [customers, setCustomers] = useState('');
  const [members, setMembers] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailed(undefined);
    try {
      onCreated(
        await client.createCommercialAccount({
          type,
          name,
          adminUserId: admin.trim(),
          limits: { customers: Number(customers), members: Number(members) },
        }),
      );
      setName('');
      setAdmin('');
    } catch (error) {
      setFailed(errorOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="platform__form" onSubmit={(e) => void submit(e)}>
      <h3>
        <FormattedMessage id="platform.commercial.new" />
      </h3>
      <label htmlFor={`${id}-type`}>
        <FormattedMessage id="platform.commercial.type" />
      </label>
      <select
        id={`${id}-type`}
        value={type}
        onChange={(e) => setType(e.target.value === 'agency' ? 'agency' : 'partner')}
      >
        <option value="partner">{intl.formatMessage({ id: 'partners.type.partner' })}</option>
        <option value="agency">{intl.formatMessage({ id: 'partners.type.agency' })}</option>
      </select>
      <label htmlFor={`${id}-name`}>
        <FormattedMessage id="platform.commercial.name" />
      </label>
      <input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required />
      <label htmlFor={`${id}-admin`}>
        <FormattedMessage id="platform.commercial.admin" />
      </label>
      <input
        id={`${id}-admin`}
        value={admin}
        onChange={(e) => setAdmin(e.target.value)}
        required
        spellCheck={false}
      />
      {currentUserId === undefined ? null : (
        <Button variant="secondary" onClick={() => setAdmin(currentUserId)}>
          <FormattedMessage id="platform.commercial.useMine" />
        </Button>
      )}
      <label htmlFor={`${id}-customers`}>
        <FormattedMessage id="platform.commercial.customers" />
      </label>
      <input
        id={`${id}-customers`}
        type="number"
        min={0}
        value={customers}
        onChange={(e) => setCustomers(e.target.value)}
        required
      />
      <label htmlFor={`${id}-members`}>
        <FormattedMessage id="platform.commercial.members" />
      </label>
      <input
        id={`${id}-members`}
        type="number"
        min={1}
        value={members}
        onChange={(e) => setMembers(e.target.value)}
        required
      />
      <Button type="submit" disabled={busy}>
        <FormattedMessage id="platform.commercial.create" />
      </Button>
      {failed === undefined ? null : (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="platform.refused" values={{ reason: failed }} />
        </p>
      )}
    </form>
  );
}

function DomainRow({
  domain: d,
  client,
  onChange,
}: {
  readonly domain: DomainView;
  readonly client: PlatformClient;
  readonly onChange: (d: DomainView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const move = async (status: DomainStatus) => {
    setBusy(true);
    setFailed(undefined);
    try {
      onChange(await client.setDomainStatus(d, status));
    } catch (error) {
      setFailed(errorOf(error));
    } finally {
      setBusy(false);
    }
  };
  const targetId =
    d.target.type === 'organization' ? d.target.organizationId : d.target.commercialAccountId;
  return (
    <li className="documents__item" aria-label={d.hostname}>
      <span className="documents__name">{d.hostname}</span>
      <span className="documents__meta">
        <FormattedMessage id={`platform.domains.status.${d.status}`} /> ·{' '}
        <FormattedMessage id={`platform.domains.target.${d.target.type}`} /> <code>{targetId}</code>
      </span>
      <div className="partners__actions">
        {NEXT[d.status].map((status) => (
          <Button
            key={status}
            variant="secondary"
            disabled={busy}
            onClick={() => void move(status)}
          >
            <FormattedMessage id={`platform.domains.to.${status}`} />
          </Button>
        ))}
      </div>
      {failed === undefined ? null : (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="platform.refused" values={{ reason: failed }} />
        </p>
      )}
    </li>
  );
}

function NewDomain({
  client,
  accounts,
  onCreated,
}: {
  readonly client: PlatformClient;
  readonly accounts: readonly CommercialAccountView[];
  readonly onCreated: (d: DomainView) => void;
}) {
  const intl = useIntl();
  const id = useId();
  const [hostname, setHostname] = useState('');
  const [kind, setKind] = useState<'organization' | 'commercial_account'>('organization');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailed(undefined);
    try {
      onCreated(
        await client.createDomain(
          hostname.trim(),
          kind === 'organization'
            ? { type: 'organization', organizationId: target.trim() }
            : { type: 'commercial_account', commercialAccountId: target },
        ),
      );
      setHostname('');
      setTarget('');
    } catch (error) {
      setFailed(errorOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="platform__form" onSubmit={(e) => void submit(e)}>
      <h3>
        <FormattedMessage id="platform.domains.new" />
      </h3>
      <label htmlFor={`${id}-host`}>
        <FormattedMessage id="platform.domains.hostname" />
      </label>
      <input
        id={`${id}-host`}
        value={hostname}
        onChange={(e) => setHostname(e.target.value)}
        placeholder="app.example.com"
        required
        spellCheck={false}
      />
      <label htmlFor={`${id}-kind`}>
        <FormattedMessage id="platform.domains.for" />
      </label>
      <select
        id={`${id}-kind`}
        value={kind}
        onChange={(e) => {
          setKind(e.target.value === 'commercial_account' ? 'commercial_account' : 'organization');
          setTarget('');
        }}
      >
        <option value="organization">
          {intl.formatMessage({ id: 'platform.domains.target.organization' })}
        </option>
        <option value="commercial_account">
          {intl.formatMessage({ id: 'platform.domains.target.commercial_account' })}
        </option>
      </select>
      <label htmlFor={`${id}-target`}>
        <FormattedMessage id={`platform.domains.target.${kind}`} />
      </label>
      {kind === 'organization' ? (
        <input
          id={`${id}-target`}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          required
          spellCheck={false}
        />
      ) : (
        <select
          id={`${id}-target`}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          required
        >
          <option value="" />
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
      <Button type="submit" disabled={busy}>
        <FormattedMessage id="platform.domains.create" />
      </Button>
      {failed === undefined ? null : (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="platform.refused" values={{ reason: failed }} />
        </p>
      )}
    </form>
  );
}
