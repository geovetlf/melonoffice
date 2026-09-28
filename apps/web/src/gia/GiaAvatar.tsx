import { useIntl } from '@melonoffice/i18n';
import { useId } from 'react';
import { GiaArtwork } from './artwork.js';

/**
 * GIA's face wherever GIA appears (ADR-0050). The artwork is its own file; this frame gives it a
 * size, a name for screen readers (or none, when a visible name sits beside it) and the gentle
 * blink that only plays when the person has not asked for reduced motion.
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
  const idPrefix = `gia${useId().replaceAll(':', '')}`;
  return (
    <svg
      className={['gia-avatar', className].filter(Boolean).join(' ')}
      viewBox="0 0 120 120"
      width={size}
      height={size}
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': intl.formatMessage({ id: 'gia.avatar.label' }) })}
      focusable="false"
    >
      <GiaArtwork idPrefix={idPrefix} />
    </svg>
  );
}
