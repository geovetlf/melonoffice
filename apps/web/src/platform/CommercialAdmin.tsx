import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, FormSection, StateMessage } from '@melonoffice/ui';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { CreditGrant } from './CreditGrant.js';
import {
  errorOf,
  type CommercialAccountStatus,
  type CommercialAccountView,
  type DomainStatus,
  type DomainView,
  type NewCommercialAccount,
  type PlatformClient,
} from './platformClient.js';
import { REAUTHENTICATION_REQUIRED, SignInAgain } from '../identity/SignInAgain.js';

/**
 * The platform administrator's commercial tools (ADR-0088): create reseller and white-label accounts
 * (ADR-0098; older partner and agency accounts keep working) with their first admin and limits
 * (ADR-0086, "Solo plataforma"), and register domains and move
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
      <section className="mo-panel mo-page-section" aria-labelledby="platform-commercial">
        <h2 id="platform-commercial" className="mo-section-title">
          <FormattedMessage id="platform.commercial.title" />
        </h2>
        <p className="mo-lead">
          <FormattedMessage id="platform.commercial.lead" />
        </p>
        {accounts === 'loading' ? null : accounts === 'error' ? (
          <StateMessage kind="error">
            <FormattedMessage id="platform.commercial.error" />
          </StateMessage>
        ) : accounts.length === 0 ? (
          <StateMessage kind="empty">
            <FormattedMessage id="platform.commercial.none" />
          </StateMessage>
        ) : (
          <ul className="mo-list" aria-label="accounts">
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

      <section className="mo-panel mo-page-section" aria-labelledby="platform-domains">
        <h2 id="platform-domains" className="mo-section-title">
          <FormattedMessage id="platform.domains.title" />
        </h2>
        <p className="mo-lead">
          <FormattedMessage id="platform.domains.lead" />
        </p>
        {domains === 'loading' ? null : domains === 'error' ? (
          <StateMessage kind="error">
            <FormattedMessage id="platform.domains.error" />
          </StateMessage>
        ) : domains.length === 0 ? (
          <StateMessage kind="empty">
            <FormattedMessage id="platform.domains.none" />
          </StateMessage>
        ) : (
          <ul className="mo-list">
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
  const [resellers, setResellers] = useState('');
  const whiteLabel = a.type === 'white_label';

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
    <li className="mo-list-item" aria-label={a.name}>
      <div className="mo-list-item__main">
        <span className="mo-list-item__title">{a.name}</span>
        <span className="mo-list-item__meta">
          <FormattedMessage id={`partners.type.${a.type}`} /> ·{' '}
          <FormattedMessage id={`platform.commercial.status.${status}`} /> ·{' '}
          <FormattedMessage
            id="platform.commercial.limits"
            values={{ customers: a.limits?.customers ?? 0, members: a.limits?.members ?? 0 }}
          />
          {whiteLabel ? (
            <>
              {' · '}
              <FormattedMessage
                id="platform.commercial.resellerLimit"
                values={{ resellers: a.limits?.resellers ?? 0 }}
              />
            </>
          ) : null}
        </span>
        <code className="mo-list-item__meta">{a.id}</code>
      </div>
      {open ? (
        <div className="mo-list-item__actions">
          {(ACCOUNT_NEXT[status] ?? []).map((next) => (
            <Button
              key={next}
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => client.setAccountStatus(a, next))}
            >
              <FormattedMessage id={`platform.commercial.to.${next}`} />
            </Button>
          ))}
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => {
              setEditing((x) => !x);
              setClosing(false);
              setCustomers(String(a.limits?.customers ?? 0));
              setMembers(String(a.limits?.members ?? 1));
              setResellers(String(a.limits?.resellers ?? 0));
            }}
          >
            <FormattedMessage id="platform.commercial.editLimits" />
          </Button>
          <Button
            variant="secondary"
            size="sm"
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
          className="mo-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              client.setAccountLimits(a, {
                customers: Number(customers),
                members: Number(members),
                ...(whiteLabel ? { resellers: Number(resellers) } : {}),
              }),
            );
          }}
        >
          <div className="mo-form-section__fields">
            <div className="mo-field">
              <label className="mo-label" htmlFor={`${id}-customers`}>
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
            </div>
            <div className="mo-field">
              <label className="mo-label" htmlFor={`${id}-members`}>
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
            </div>
            {whiteLabel ? (
              <div className="mo-field">
                <label className="mo-label" htmlFor={`${id}-resellers`}>
                  <FormattedMessage id="platform.commercial.resellers" />
                </label>
                <input
                  id={`${id}-resellers`}
                  type="number"
                  min={0}
                  value={resellers}
                  onChange={(e) => setResellers(e.target.value)}
                  required
                />
              </div>
            ) : null}
          </div>
          <div className="mo-form__actions">
            <Button type="submit" size="sm" disabled={busy}>
              <FormattedMessage id="platform.commercial.saveLimits" />
            </Button>
          </div>
        </form>
      ) : null}
      {closing ? (
        <form
          className="mo-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => client.setAccountStatus(a, 'closed', typed));
          }}
        >
          <p className="mo-hint">
            <FormattedMessage id="platform.commercial.closeWarning" />
          </p>
          <div className="mo-field">
            <label className="mo-label" htmlFor={`${id}-confirm`}>
              <FormattedMessage id="platform.commercial.closeConfirm" values={{ name: a.name }} />
            </label>
            <input
              id={`${id}-confirm`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="mo-form__actions">
            <Button type="submit" variant="danger" size="sm" disabled={busy || typed !== a.name}>
              <FormattedMessage id="platform.commercial.closeForGood" />
            </Button>
          </div>
        </form>
      ) : null}
      {failed === undefined ? null : failed === REAUTHENTICATION_REQUIRED ? (
        <SignInAgain />
      ) : (
        <StateMessage kind="error" inline>
          <FormattedMessage id="platform.refused" values={{ reason: failed }} />
        </StateMessage>
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
  const [type, setType] = useState<NewCommercialAccount['type']>('reseller');
  const [name, setName] = useState('');
  const [admin, setAdmin] = useState('');
  const [customers, setCustomers] = useState('');
  const [members, setMembers] = useState('');
  const [resellers, setResellers] = useState('');
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
          limits: {
            customers: Number(customers),
            members: Number(members),
            ...(type === 'white_label' ? { resellers: Number(resellers) } : {}),
          },
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
    <form className="mo-form" onSubmit={(e) => void submit(e)}>
      <FormSection title={<FormattedMessage id="platform.commercial.new" />} titleAs="h3">
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-type`}>
            <FormattedMessage id="platform.commercial.type" />
          </label>
          <select
            id={`${id}-type`}
            value={type}
            onChange={(e) => setType(e.target.value === 'white_label' ? 'white_label' : 'reseller')}
          >
            <option value="reseller">{intl.formatMessage({ id: 'partners.type.reseller' })}</option>
            <option value="white_label">
              {intl.formatMessage({ id: 'partners.type.white_label' })}
            </option>
          </select>
        </div>
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-name`}>
            <FormattedMessage id="platform.commercial.name" />
          </label>
          <input
            id={`${id}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-admin`}>
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
            <Button
              variant="secondary"
              size="sm"
              className="platform__field-action"
              onClick={() => setAdmin(currentUserId)}
            >
              <FormattedMessage id="platform.commercial.useMine" />
            </Button>
          )}
        </div>
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-customers`}>
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
        </div>
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-members`}>
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
        </div>
        {type === 'white_label' ? (
          <div className="mo-field">
            <label className="mo-label" htmlFor={`${id}-resellers`}>
              <FormattedMessage id="platform.commercial.resellers" />
            </label>
            <input
              id={`${id}-resellers`}
              type="number"
              min={0}
              value={resellers}
              onChange={(e) => setResellers(e.target.value)}
              required
            />
          </div>
        ) : null}
      </FormSection>
      <div className="mo-form__actions">
        <Button type="submit" disabled={busy}>
          <FormattedMessage id="platform.commercial.create" />
        </Button>
      </div>
      {failed === undefined ? null : failed === REAUTHENTICATION_REQUIRED ? (
        <SignInAgain />
      ) : (
        <StateMessage kind="error">
          <FormattedMessage id="platform.refused" values={{ reason: failed }} />
        </StateMessage>
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
    <li className="mo-list-item" aria-label={d.hostname}>
      <div className="mo-list-item__main">
        <span className="mo-list-item__title">{d.hostname}</span>
        <span className="mo-list-item__meta">
          <FormattedMessage id={`platform.domains.status.${d.status}`} /> ·{' '}
          <FormattedMessage id={`platform.domains.target.${d.target.type}`} />{' '}
          <code>{targetId}</code>
        </span>
      </div>
      <div className="mo-list-item__actions">
        {NEXT[d.status].map((status) => (
          <Button
            key={status}
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void move(status)}
          >
            <FormattedMessage id={`platform.domains.to.${status}`} />
          </Button>
        ))}
      </div>
      {failed === undefined ? null : failed === REAUTHENTICATION_REQUIRED ? (
        <SignInAgain />
      ) : (
        <StateMessage kind="error" inline>
          <FormattedMessage id="platform.refused" values={{ reason: failed }} />
        </StateMessage>
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
    <form className="mo-form" onSubmit={(e) => void submit(e)}>
      <FormSection title={<FormattedMessage id="platform.domains.new" />} titleAs="h3">
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-host`}>
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
        </div>
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-kind`}>
            <FormattedMessage id="platform.domains.for" />
          </label>
          <select
            id={`${id}-kind`}
            value={kind}
            onChange={(e) => {
              setKind(
                e.target.value === 'commercial_account' ? 'commercial_account' : 'organization',
              );
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
        </div>
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-target`}>
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
        </div>
      </FormSection>
      <div className="mo-form__actions">
        <Button type="submit" disabled={busy}>
          <FormattedMessage id="platform.domains.create" />
        </Button>
      </div>
      {failed === undefined ? null : failed === REAUTHENTICATION_REQUIRED ? (
        <SignInAgain />
      ) : (
        <StateMessage kind="error">
          <FormattedMessage id="platform.refused" values={{ reason: failed }} />
        </StateMessage>
      )}
    </form>
  );
}
