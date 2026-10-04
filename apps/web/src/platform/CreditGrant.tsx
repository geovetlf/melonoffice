import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useId, useState, type FormEvent } from 'react';
import {
  errorOf,
  GRANT_REASONS,
  type CreditGrantResult,
  type GrantReason,
  type PlatformClient,
  type PlatformOrganizationView,
} from './platformClient.js';
import { REAUTHENTICATION_REQUIRED, SignInAgain } from '../identity/SignInAgain.js';

/**
 * Adding credits to an organization by hand (ADR-0091), for the platform administrator only: the
 * credits were paid for outside MelonOffice. Find the organization, type the amount and why,
 * confirm, and see the result. There is no price here and no second balance: the API adds a grant
 * to the organization's one Credits wallet.
 *
 * Every grant carries an idempotency key made once for it. A double click, a lost answer or a
 * refresh sends the same key again, so the API answers the first grant and adds nothing twice.
 * The key of a grant not yet answered is kept in this browser tab until it is answered or dropped.
 */

interface Pending {
  readonly organizationId: string;
  readonly amount: number;
  readonly reason: GrantReason;
  readonly idempotencyKey: string;
}

const STORAGE_KEY = 'melonoffice.platform.pendingGrant';

const readPending = (): Pending | undefined => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return undefined;
    const value = JSON.parse(raw) as Partial<Pending>;
    return typeof value.organizationId === 'string' &&
      typeof value.amount === 'number' &&
      (GRANT_REASONS as readonly unknown[]).includes(value.reason) &&
      typeof value.idempotencyKey === 'string'
      ? (value as Pending)
      : undefined;
  } catch {
    return undefined;
  }
};
const keepPending = (pending: Pending | undefined) => {
  try {
    if (pending === undefined) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
  } catch {
    // Without storage a refresh forgets the key; the grant itself is still made once per key.
  }
};

export function CreditGrant({ client }: { readonly client: PlatformClient }) {
  const intl = useIntl();
  const id = useId();
  const [restored] = useState(readPending);
  const [organizationId, setOrganizationId] = useState(restored?.organizationId ?? '');
  const [found, setFound] = useState<PlatformOrganizationView>();
  const [amount, setAmount] = useState(restored === undefined ? '' : String(restored.amount));
  const [reason, setReason] = useState<GrantReason>(restored?.reason ?? 'manual_purchase');
  // A grant not yet answered: the one the confirm step shows and the one a retry sends again.
  const [pending, setPending] = useState<Pending | undefined>(restored);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [done, setDone] = useState<CreditGrantResult>();

  const drop = () => {
    setPending(undefined);
    keepPending(undefined);
  };

  const find = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailed(undefined);
    setDone(undefined);
    setFound(undefined);
    try {
      setFound(await client.organization(organizationId.trim()));
    } catch (error) {
      setFailed(errorOf(error));
    } finally {
      setBusy(false);
    }
  };

  const review = (event: FormEvent) => {
    event.preventDefault();
    if (found === undefined) return;
    const next: Pending = {
      organizationId: found.organization.id,
      amount: Number(amount),
      reason,
      idempotencyKey: crypto.randomUUID(),
    };
    setDone(undefined);
    setFailed(undefined);
    setPending(next);
  };

  const confirm = async () => {
    if (pending === undefined || busy) return;
    keepPending(pending);
    setBusy(true);
    setFailed(undefined);
    try {
      const result = await client.grantCredits(pending.organizationId, {
        amount: pending.amount,
        reason: pending.reason,
        idempotencyKey: pending.idempotencyKey,
      });
      setDone(result);
      drop();
      setAmount('');
      setFound((view) =>
        view === undefined
          ? view
          : {
              ...view,
              credits: { balance: result.balance, updatedAt: result.grant.createdAt },
            },
      );
    } catch (error) {
      // The key stays: sending again asks about this same grant, never a new one.
      setFailed(errorOf(error));
    } finally {
      setBusy(false);
    }
  };

  const shownName =
    found !== undefined && found.organization.id === pending?.organizationId
      ? found.organization.name
      : pending?.organizationId;

  return (
    <section className="mo-panel mo-page-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="mo-section-title">
        <FormattedMessage id="platform.credits.title" />
      </h2>
      <p className="mo-lead">
        <FormattedMessage id="platform.credits.lead" />
      </p>

      {pending === undefined ? (
        <>
          <form className="mo-form" onSubmit={(e) => void find(e)}>
            <div className="mo-field">
              <label className="mo-label" htmlFor={`${id}-org`}>
                <FormattedMessage id="platform.credits.organization" />
              </label>
              <input
                id={`${id}-org`}
                value={organizationId}
                onChange={(e) => {
                  setOrganizationId(e.target.value);
                  setFound(undefined);
                }}
                required
                spellCheck={false}
              />
            </div>
            <div className="mo-form__actions">
              <Button type="submit" variant="secondary" disabled={busy}>
                <FormattedMessage id="platform.credits.find" />
              </Button>
            </div>
          </form>

          {found === undefined ? null : (
            <form className="mo-form" onSubmit={review}>
              <p className="mo-lead" aria-label="organization">
                <strong>{found.organization.name}</strong> ·{' '}
                <FormattedMessage id={`platform.credits.org.${found.organization.status}`} /> ·{' '}
                {found.credits === null ? (
                  <FormattedMessage id="platform.credits.noWallet" />
                ) : (
                  <FormattedMessage
                    id="platform.credits.balance"
                    values={{ balance: found.credits.balance }}
                  />
                )}
              </p>
              {found.organization.status === 'active' && found.credits !== null ? (
                <>
                  <div className="mo-form-section__fields">
                    <div className="mo-field">
                      <label className="mo-label" htmlFor={`${id}-amount`}>
                        <FormattedMessage id="platform.credits.amount" />
                      </label>
                      <input
                        id={`${id}-amount`}
                        type="number"
                        min={1}
                        step={1}
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        required
                      />
                    </div>
                    <div className="mo-field">
                      <label className="mo-label" htmlFor={`${id}-reason`}>
                        <FormattedMessage id="platform.credits.reason" />
                      </label>
                      <select
                        id={`${id}-reason`}
                        value={reason}
                        onChange={(e) => setReason(e.target.value as GrantReason)}
                      >
                        {GRANT_REASONS.map((r) => (
                          <option key={r} value={r}>
                            {intl.formatMessage({ id: `platform.credits.reason.${r}` })}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="mo-form__actions">
                    <Button type="submit" disabled={busy}>
                      <FormattedMessage id="platform.credits.review" />
                    </Button>
                  </div>
                </>
              ) : null}
            </form>
          )}
        </>
      ) : (
        <div className="mo-form" role="group" aria-label="confirm grant">
          {pending === restored ? (
            <p className="mo-hint">
              <FormattedMessage id="platform.credits.restored" />
            </p>
          ) : null}
          <p>
            <FormattedMessage
              id="platform.credits.confirmQuestion"
              values={{
                amount: pending.amount,
                name: shownName,
                reason: intl.formatMessage({ id: `platform.credits.reason.${pending.reason}` }),
              }}
            />
          </p>
          <div className="mo-form__actions">
            <Button disabled={busy} onClick={() => void confirm()}>
              <FormattedMessage id="platform.credits.confirm" />
            </Button>
            <Button variant="ghost" disabled={busy} onClick={drop}>
              <FormattedMessage id="platform.credits.cancel" />
            </Button>
          </div>
        </div>
      )}

      {done === undefined ? null : (
        <StateMessage kind="success">
          <FormattedMessage
            id={done.replayed ? 'platform.credits.replayed' : 'platform.credits.done'}
            values={{ amount: done.grant.amount, balance: done.balance }}
          />
        </StateMessage>
      )}
      {failed === undefined ? null : failed === REAUTHENTICATION_REQUIRED ? (
        <SignInAgain />
      ) : (
        <StateMessage kind="error">
          <FormattedMessage id="platform.refused" values={{ reason: failed }} />
        </StateMessage>
      )}
    </section>
  );
}
