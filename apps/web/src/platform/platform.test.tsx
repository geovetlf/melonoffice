import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

const bucket = (operations: number, costMicroUsd: number, credits: number) => ({
  operations,
  costMicroUsd,
  unpricedOperations: 0,
  credits,
});

/** What the API gives the platform administrator (ADR-0082). */
const PLATFORM = {
  ai: {
    environment: 'dev',
    providers: [
      {
        id: 'google-vertex-ai',
        name: 'Google Cloud Vertex AI',
        status: 'active',
        health: 'available',
        capabilities: ['text_generation'],
        environments: ['dev'],
        maxSensitivity: 'confidential',
      },
      {
        id: 'nvidia',
        name: 'NVIDIA',
        status: 'active',
        health: 'degraded',
        capabilities: ['text_generation'],
        environments: ['dev'],
        maxSensitivity: 'public',
      },
    ],
    models: [
      {
        providerId: 'google-vertex-ai',
        modelId: 'gemini-2.5-flash-lite',
        version: 'stable',
        displayName: null,
        status: 'active',
        capabilities: ['text_generation'],
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 65_536,
        pricing: {
          status: 'known',
          inputMicroUsdPerMillionTokens: 100_000,
          outputMicroUsdPerMillionTokens: 400_000,
          source: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
          asOf: '2026-09-27',
        },
        environments: ['dev'],
        maxSensitivity: 'confidential',
        terms: null,
      },
    ],
    policies: [
      {
        id: 'gia_assist',
        version: 1,
        allowedModels: ['google-vertex-ai/gemini-2.5-flash-lite'],
        environments: ['dev'],
        maxSensitivity: 'confidential',
        maxCostMicroUsd: 10_000,
        strategy: null,
        fallback: 'none',
        maxAttempts: 2,
      },
    ],
  },
  usage: {
    scope: 'platform',
    totals: bucket(3, 1_250, 2),
    by: {
      provider: { 'google-vertex-ai': bucket(2, 1_250, 2), nvidia: bucket(1, 0, 0) },
      model: { 'google-vertex-ai/gemini-2.5-flash-lite': bucket(2, 1_250, 2) },
    },
    byOrganization: [{ organizationId: 'org_1', name: 'MOpruebas', ...bucket(3, 1_250, 2) }],
  },
};

function open(at: string, configure?: (backend: ReturnType<typeof fakeBackend>) => void) {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const platformCalls = (backend: ReturnType<typeof fakeBackend>) =>
  backend.apiCalls().filter((c) => /\/v1\/platform\/ai/.test(c.url));

describe('the platform AI view (ADR-0082)', () => {
  it('shows the platform administrator providers, health, models, routing and internal cost', async () => {
    open('/platform', (b) => {
      b.options.platform = PLATFORM;
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Platform: AI' })).toBeTruthy();
    const providers = within(await screen.findByRole('region', { name: 'AI providers' }));
    expect(providers.getByText('NVIDIA')).toBeTruthy();
    expect(providers.getByText('Degraded')).toBeTruthy();
    const models = within(screen.getByRole('region', { name: 'Models' }));
    expect(models.getByText('in $0.10 · out $0.40')).toBeTruthy();
    const routing = within(screen.getByRole('region', { name: 'Routing and fallback' }));
    expect(routing.getByText('gia_assist v1')).toBeTruthy();
    expect(routing.getByText(/no fallback · 2 attempts · at most \$0\.01 a call/)).toBeTruthy();
    const byOrganization = await screen.findByRole('region', { name: 'By organization' });
    expect(within(byOrganization).getByText('MOpruebas')).toBeTruthy();
    const cost = screen.getByText('Internal AI cost', { selector: 'dt' });
    expect(within(cost.parentElement as HTMLElement).getByText('$0.00125')).toBeTruthy();
    const sidebar = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(sidebar).getByRole('link', { name: 'Platform' })).toBeTruthy();
  });

  it('reads another period from the ledger', async () => {
    const backend = open('/platform', (b) => {
      b.options.platform = PLATFORM;
    });
    await screen.findByRole('region', { name: 'By organization' });
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    await vi.waitFor(() => expect(platformCalls(backend).length).toBeGreaterThanOrEqual(3));
  });

  it('says so when the view cannot be read', async () => {
    open('/platform', (b) => {
      b.options.platform = { ...PLATFORM, aiFails: true };
    });
    expect(await screen.findByText('The platform AI view could not be loaded.')).toBeTruthy();
  });

  it('is invisible to a company owner who is not a platform administrator', async () => {
    const backend = open('/platform', (b) => {
      b.options.permissions.push('ai_usage.read');
    });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('heading', { level: 1, name: 'Platform: AI' })).toBeNull();
    const sidebar = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(sidebar).queryByText('Platform')).toBeNull();
    expect(platformCalls(backend)).toHaveLength(0);
  });
});
