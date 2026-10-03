import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { navigate } from '../identity/router.js';
import { useOfficeData } from '../office/OfficeData.js';
import { paths } from '../shell/routes.js';

/**
 * What a person sees when an action was refused for credits (D-12): that it did not run, what
 * is available now, and what they can do: buy credits or see their plan, both on the plan and
 * credits panel. Buying more credits never forces a plan change, and nothing here buys, upgrades
 * or retries by itself.
 */
export function OutOfCredits({
  estimate,
}: {
  /** About how many credits the refused action would have used, when the API said. */
  readonly estimate?: number | undefined;
} = {}) {
  const intl = useIntl();
  const { credits } = useOfficeData();
  const available =
    credits.status === 'ready' && credits.value.status === 'present'
      ? (credits.value.available ?? credits.value.balance)
      : undefined;
  return (
    <span className="out-of-credits">
      <FormattedMessage id="credits.out.title" />{' '}
      {estimate === undefined ? null : (
        <>
          <FormattedMessage id="credits.out.estimate" values={{ count: estimate }} />{' '}
        </>
      )}
      {available === undefined ? null : (
        <FormattedMessage id="credits.out.available" values={{ count: available }} />
      )}
      <span className="out-of-credits__options">
        <FormattedMessage id="credits.out.options" />{' '}
        <button
          type="button"
          className="mo-button mo-button--secondary mo-button--sm"
          onClick={() => navigate(paths.aiUsage())}
        >
          <FormattedMessage id="credits.out.buy" />
        </button>{' '}
        <button
          type="button"
          className="mo-button mo-button--ghost mo-button--sm"
          onClick={() => navigate(paths.aiUsage())}
          aria-label={intl.formatMessage({ id: 'credits.out.review' })}
        >
          <FormattedMessage id="credits.out.review" />
        </button>
      </span>
    </span>
  );
}
