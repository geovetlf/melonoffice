import { useIntl } from '@melonoffice/i18n';
import type { ReactNode } from 'react';
import { useBrand } from '../brand/brand.js';
import { navigate } from '../identity/router.js';
import { Icon, type IconName } from '../office/icons.js';
import { MELON_MARK, MELON_MARK_SRCSET } from './mark.js';
import { paths, type Route } from './routes.js';

/**
 * The Home's rail on a computer: the office's way in at a glance (the Home, GIA, what waits on
 * the person, the company) and the button that opens the whole menu. It is a shortcut, not a
 * second menu: the menu (`Sidebar`, the glass panel) keeps every link, route and permission, and
 * the bell in the top bar keeps what waits. On a tablet and a phone the rail is not shown: the
 * top bar's burger opens the same menu.
 */
export function HomeRail({
  route,
  canReadMemory,
  menuOpen,
  onMenu,
}: {
  readonly route: Route;
  /** The company's memory (ADR-0056), for a member who may read the business or its knowledge. */
  readonly canReadMemory: boolean;
  readonly menuOpen: boolean;
  readonly onMenu: () => void;
}) {
  const intl = useIntl();
  const brand = useBrand();
  // The bell is the top bar's: the rail opens it where it is, so what waits is read once.
  const bell = () => {
    const menu = document.querySelector<HTMLDetailsElement>('.topbar .notifications');
    if (menu === null) return;
    menu.open = true;
    menu.querySelector<HTMLElement>('summary')?.focus();
  };
  return (
    <nav className="rail" aria-label={intl.formatMessage({ id: 'nav.rail' })}>
      {brand?.productName === undefined ? (
        <img
          className="rail__mark"
          src={MELON_MARK}
          srcSet={MELON_MARK_SRCSET}
          sizes="40px"
          alt=""
          width={40}
          height={40}
        />
      ) : null}
      <ul className="rail__list">
        <RailLink
          icon="home"
          path={paths.home()}
          current={route.kind === 'home'}
          label={intl.formatMessage({ id: 'nav.home' })}
        />
        <RailLink
          icon="gia"
          path={paths.gia()}
          current={route.kind === 'gia'}
          label={intl.formatMessage({ id: 'gia.name' })}
        />
        <li>
          <RailButton
            icon="bell"
            label={intl.formatMessage({ id: 'nav.rail.notifications' })}
            onClick={bell}
          />
        </li>
        {canReadMemory ? (
          <RailLink
            icon="building"
            path={paths.memory()}
            current={route.kind === 'memory'}
            label={intl.formatMessage({ id: 'nav.rail.company' })}
          />
        ) : null}
      </ul>
      <RailButton
        icon={menuOpen ? 'close' : 'menu'}
        label={intl.formatMessage({ id: menuOpen ? 'nav.close' : 'nav.rail.menu' })}
        onClick={onMenu}
        expanded={menuOpen}
      />
    </nav>
  );
}

function RailLink({
  icon,
  path,
  current,
  label,
}: {
  readonly icon: IconName;
  readonly path: string;
  readonly current: boolean;
  readonly label: string;
}) {
  return (
    <li>
      <a
        href={path}
        className="rail__item"
        aria-current={current ? 'page' : undefined}
        aria-label={label}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          navigate(path);
        }}
      >
        <Icon name={icon} size={20} />
        <Tip>{label}</Tip>
      </a>
    </li>
  );
}

function RailButton({
  icon,
  label,
  onClick,
  expanded,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly onClick: () => void;
  readonly expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className={`rail__item${expanded === undefined ? '' : ' rail__menu'}`}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={expanded === undefined ? undefined : 'app-sidebar'}
      onClick={onClick}
    >
      <Icon name={icon} size={20} />
      <Tip>{label}</Tip>
    </button>
  );
}

/** The item's name beside it, for the pointer and the keyboard; screen readers have its label. */
function Tip({ children }: { readonly children: ReactNode }) {
  return (
    <span className="rail__tip" aria-hidden="true">
      {children}
    </span>
  );
}
