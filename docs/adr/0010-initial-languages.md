# ADR-0010: English and Spanish first, extensible i18n

- Status: Accepted (D-17, approved by Geovet on 2026-09-26)
- Date: 2026-09-26

## Decision

- English (source catalog) and Spanish are the first supported languages.
- UI text uses ICU MessageFormat through FormatJS (`react-intl`). No user-visible text is hard-coded in components.
- Adding a language (for example Italian, Chinese, Russian or Japanese) means adding a catalog file and one registry entry in `packages/i18n`; tests require every catalog to have exactly the source keys.
- Locale (language and formatting), time zone, currency and jurisdiction are separate settings.
