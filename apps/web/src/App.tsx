import { FormattedMessage, SUPPORTED_LOCALES, type Locale } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';

export interface AppProps {
  readonly locale: Locale;
  readonly onLocaleChange: (locale: Locale) => void;
}

/**
 * Phase 1A placeholder page. It proves the design tokens and i18n wiring;
 * the application shell and both Home modes arrive in later phases.
 */
export function App({ locale, onLocaleChange }: AppProps) {
  return (
    <main className="placeholder">
      <h1>
        <FormattedMessage id="app.name" />
      </h1>
      <p className="placeholder__tagline">
        <FormattedMessage id="app.tagline" />
      </p>
      <p>
        <FormattedMessage id="foundation.status" />
      </p>
      <nav aria-labelledby="language-label" className="placeholder__languages">
        <span id="language-label">
          <FormattedMessage id="language.label" />
        </span>
        {SUPPORTED_LOCALES.map((option) => (
          <Button
            key={option}
            variant="secondary"
            lang={option}
            aria-pressed={option === locale}
            onClick={() => onLocaleChange(option)}
          >
            <FormattedMessage id={`language.name.${option}`} />
          </Button>
        ))}
      </nav>
    </main>
  );
}
