import { useIntl } from '@melonoffice/i18n';
import { GIA_FACE } from './character.js';

/**
 * GIA's face wherever a small round avatar stands for her (ADR-0050): the face from her portrait
 * (`character.tsx`), so she is the same person here as in the office and the chat. It has a name
 * for screen readers, or none when a visible name sits beside it. It never moves.
 */
export function GiaAvatar({
  size = 44,
  decorative = false,
  className,
}: {
  readonly size?: number;
  /** True when GIA's name is already written next to the avatar. */
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  const intl = useIntl();
  return (
    <img
      className={['gia-avatar', className].filter(Boolean).join(' ')}
      src={GIA_FACE}
      width={size}
      height={size}
      alt={decorative ? '' : intl.formatMessage({ id: 'gia.avatar.label' })}
      aria-hidden={decorative ? true : undefined}
      decoding="async"
      draggable={false}
    />
  );
}
