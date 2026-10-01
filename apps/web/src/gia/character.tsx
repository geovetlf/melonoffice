import { useIntl } from '@melonoffice/i18n';

/**
 * GIA as a person, wherever MelonOffice shows her: one character, cut from her official
 * reference sheet into separate pictures (`./art`). The office uses her whole body, seen from the
 * side she is facing; conversations use her portrait from the chest up. Every picture keeps the
 * same face, hair, glasses and suit, so she is the same person in the building and in the chat.
 */

/** Her whole body, by the side she shows. Every view is drawn at the same scale. */
export type GiaView =
  | 'front'
  | 'three-quarter'
  | 'profile-left'
  | 'profile-right'
  | 'back'
  | 'away-right'
  | 'walk-toward'
  | 'walk-tablet';

/** Her portrait from the chest up: at rest, reading her tablet, or in conversation. */
export type GiaPortraitKind = 'portrait' | 'portrait-tablet' | 'portrait-talk';

const ART = import.meta.glob<string>('./art/*.webp', { eager: true, import: 'default' });
const art = (name: string) => ART[`./art/${name}.webp`] ?? '';

/** Each view's size in pixels: they share one scale, so a view's height is her height in it. */
export const GIA_BODY: Readonly<
  Record<GiaView, { readonly width: number; readonly height: number }>
> = {
  front: { width: 110, height: 363 },
  'three-quarter': { width: 110, height: 363 },
  'profile-left': { width: 112, height: 360 },
  'profile-right': { width: 112, height: 362 },
  back: { width: 105, height: 362 },
  'away-right': { width: 119, height: 362 },
  'walk-toward': { width: 103, height: 354 },
  'walk-tablet': { width: 133, height: 362 },
};

/** Her standing height in the pictures, the front view's. */
const STANDING = GIA_BODY.front.height;

/**
 * Her whole body, standing on the bottom edge of the element: `height` is how tall she stands
 * (a view taken mid-step is drawn a little shorter, as she is). Always decorative: where she
 * stands, her name and what she does are said by the control around her.
 */
export function GiaFigure({
  view,
  height,
  className,
  eager = false,
}: {
  readonly view: GiaView;
  /** Her standing height, as a CSS length. */
  readonly height: string;
  readonly className?: string;
  readonly eager?: boolean;
}) {
  const size = GIA_BODY[view];
  return (
    <img
      className={['gia-figure', className].filter(Boolean).join(' ')}
      src={art(`body-${view}`)}
      width={size.width}
      height={size.height}
      style={{ height: `calc(${height} * ${(size.height / STANDING).toFixed(4)})` }}
      alt=""
      aria-hidden="true"
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      data-view={view}
    />
  );
}

/** Her portrait from the chest up, for conversations. Decorative unless `label` is set. */
export function GiaPortrait({
  kind = 'portrait',
  className,
  named = false,
}: {
  readonly kind?: GiaPortraitKind;
  readonly className?: string;
  /** True when no visible name sits beside it: it is then named for screen readers. */
  readonly named?: boolean;
}) {
  const intl = useIntl();
  return (
    <img
      className={['gia-portrait', className].filter(Boolean).join(' ')}
      src={art(kind)}
      width={180}
      height={245}
      alt={named ? intl.formatMessage({ id: 'gia.avatar.label' }) : ''}
      {...(named ? {} : { 'aria-hidden': true })}
      decoding="async"
      draggable={false}
    />
  );
}

/** Her face, for small round avatars. */
export const GIA_FACE = art('face');
