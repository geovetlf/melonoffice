import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useId, useMemo, useState } from 'react';
import { LanguageSwitcher, type LocaleProps } from '../identity/pages.js';
import { navigate } from '../identity/router.js';
import { AgentAvatar } from '../office/agents.js';
import { departmentName, officeSlug } from '../office/departments.js';
import { Icon } from '../office/icons.js';
import { readyList, useOfficeData } from '../office/OfficeData.js';
import { paths } from './routes.js';

/**
 * The top bar (ADR-0040): search, notifications, how many agents the office has, the
 * organization and the person. Everything shown is the API's answer; nothing is made up.
 */
export function TopBar({
  organizationName,
  email,
  onSignOut,
  menuOpen,
  onMenu,
  locale,
}: {
  readonly organizationName: string;
  readonly email: string;
  readonly onSignOut: () => void;
  readonly menuOpen: boolean;
  readonly onMenu: () => void;
  readonly locale: LocaleProps;
}) {
  const intl = useIntl();
  const { specialists } = useOfficeData();
  const active = readyList(specialists).filter((s) => s.status === 'active').length;
  return (
    <header className="topbar">
      <button
        type="button"
        className="topbar__menu"
        aria-expanded={menuOpen}
        aria-controls="app-sidebar"
        aria-label={intl.formatMessage({ id: menuOpen ? 'nav.close' : 'nav.open' })}
        onClick={onMenu}
      >
        <Icon name={menuOpen ? 'close' : 'menu'} size={22} />
      </button>
      <GlobalSearch />
      <div className="topbar__end">
        <button
          type="button"
          className="topbar__icon"
          aria-disabled="true"
          aria-label={intl.formatMessage({ id: 'topbar.notifications' })}
          title={intl.formatMessage({ id: 'topbar.noNotifications' })}
        >
          <Icon name="bell" size={20} />
        </button>
        {specialists.status === 'ready' ? (
          <span className="topbar__agents">
            <span
              className={`topbar__dot${active > 0 ? ' topbar__dot--on' : ''}`}
              aria-hidden="true"
            />
            <FormattedMessage id="office.agents.active" values={{ count: active }} />
          </span>
        ) : null}
        <span className="topbar__org">
          <Icon name="building" size={16} />
          <span className="topbar__org-name">{organizationName}</span>
        </span>
        <details className="user-menu">
          <summary aria-label={intl.formatMessage({ id: 'topbar.account' })}>
            <AgentAvatar name={email} size={36} />
          </summary>
          <div className="user-menu__panel">
            <p className="user-menu__email">{email}</p>
            <LanguageSwitcher {...locale} />
            <Button variant="secondary" onClick={onSignOut}>
              <Icon name="signOut" size={16} /> <FormattedMessage id="auth.signOut" />
            </Button>
          </div>
        </details>
      </div>
    </header>
  );
}

interface SearchResult {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly path: string;
}

/**
 * Searches what the office knows: its departments and agents. Tasks and projects join the results
 * when they exist.
 */
export function GlobalSearch() {
  const intl = useIntl();
  const listId = useId();
  const { departments, specialists } = useOfficeData();
  const [query, setQuery] = useState('');
  const results = useMemo<readonly SearchResult[]>(() => {
    const q = query.trim().toLocaleLowerCase();
    if (q.length < 1) return [];
    const depts = readyList(departments);
    const found: SearchResult[] = [];
    for (const department of depts) {
      const name = departmentName(intl, department, 'name');
      if (name.toLocaleLowerCase().includes(q)) {
        found.push({
          id: department.id,
          label: name,
          detail: intl.formatMessage({ id: 'search.kind.department' }),
          path: paths.office(officeSlug(department)),
        });
      }
    }
    for (const agent of readyList(specialists)) {
      if (!agent.displayName.toLocaleLowerCase().includes(q)) continue;
      const department = depts.find((d) => d.id === agent.departmentId);
      if (department === undefined) continue;
      const slug = officeSlug(department);
      found.push({
        id: agent.id,
        label: agent.displayName,
        detail: departmentName(intl, department),
        path: paths.agent(slug, agent.id),
      });
    }
    return found.slice(0, 8);
  }, [query, departments, specialists, intl]);
  const go = (path: string) => {
    setQuery('');
    navigate(path);
  };
  return (
    <div className="search" role="search">
      <Icon name="search" size={18} className="search__icon" />
      <input
        className="search__input"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && results[0] !== undefined) go(results[0].path);
          if (event.key === 'Escape') setQuery('');
        }}
        placeholder={intl.formatMessage({ id: 'search.placeholder' })}
        aria-label={intl.formatMessage({ id: 'search.placeholder' })}
        aria-controls={listId}
        autoComplete="off"
      />
      {query.trim() === '' ? null : (
        <ul
          id={listId}
          className="search__results"
          aria-label={intl.formatMessage({ id: 'search.results' })}
        >
          {results.length === 0 ? (
            <li className="search__none">
              <FormattedMessage id="search.none" />
            </li>
          ) : (
            results.map((result) => (
              <li key={result.id}>
                <a
                  href={result.path}
                  onClick={(event) => {
                    event.preventDefault();
                    go(result.path);
                  }}
                >
                  <span>{result.label}</span>
                  <span className="search__detail">{result.detail}</span>
                </a>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
