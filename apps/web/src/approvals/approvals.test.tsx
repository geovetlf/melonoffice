import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

const approval = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  status,
  riskLevel: 'high',
  reason: 'approval_required',
  impact: 'changes_data',
  estimatedCredits: 2,
  executionId: `exec-${id}`,
  nodeId: 'send',
  specialist: { id: 'spec_lucia', version: 1 },
  tool: { id: 'message_send', version: 1 },
  action: 'send',
  requestedBy: 'user_ana',
  requestedAt: '2026-09-29T12:00:00.000Z',
  expiresAt: '2026-09-29T13:00:00.000Z',
  decidedAt: null,
  decidedBy: null,
  ...extra,
});

function open(at: string, configure?: (backend: ReturnType<typeof fakeBackend>) => void) {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.push('approval.read', 'approval.approve');
  backend.options.approvals = {
    org_1: [
      approval('a1', 'pending'),
      approval('a2', 'approved', { decidedAt: '2026-09-29T11:00:00.000Z' }),
    ],
  };
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const approvalCalls = (backend: ReturnType<typeof fakeBackend>) =>
  backend.apiCalls().filter((c) => c.url.includes('/approvals'));

describe('The approval center (ADR-0026)', () => {
  it('lists what is pending with what, why, risk, credits and expiry', async () => {
    open('/approvals');
    expect(await screen.findByRole('heading', { level: 1, name: 'Approvals' })).toBeTruthy();
    expect(await screen.findByText('Send a message')).toBeTruthy();
    expect(screen.getByText(/this action needs a person's approval/)).toBeTruthy();
    expect(screen.getByText(/Risk: high/)).toBeTruthy();
    expect(screen.getByText(/Estimated 2 credits/)).toBeTruthy();
    expect(screen.getByText(/Expires/)).toBeTruthy();
    const sidebar = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(sidebar).getByRole('link', { name: /Approvals/ })).toBeTruthy();
  });

  it('lists a plan step that asked a person before it runs (ADR-0146)', async () => {
    open('/approvals', (b) => {
      b.options.approvals = {
        org_1: [
          approval('a3', 'pending', {
            reason: 'plan_step_approval',
            impact: 'starts_step',
            estimatedCredits: null,
            nodeId: 'campaign',
            tool: { id: 'plan_step', version: 1 },
            action: 'start_step',
          }),
        ],
      };
    });
    expect(await screen.findByText('Start a step of a plan')).toBeTruthy();
    expect(screen.getByText(/start the step/)).toBeTruthy();
    expect(screen.getByText(/you asked to approve this step before it runs/)).toBeTruthy();
    expect(screen.getByText(/if you reject it, this branch is skipped/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });

  it('approves one, says so, and moves it to the history', async () => {
    const backend = open('/approvals');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved. The agent continues.')).toBeTruthy();
    expect(
      approvalCalls(backend).some((c) => c.method === 'POST' && c.url.endsWith('/a1/approve')),
    ).toBe(true);
    expect(screen.getByText('Nothing is waiting for your approval.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /History/ }));
    expect(screen.getAllByText(/Approved/).length).toBeGreaterThan(0);
  });

  it("shows the API's refusal as its own message", async () => {
    open('/approvals', (b) => {
      b.options.approvalDecisionFails = { error: 'approval_expired', status: 409 };
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('This approval expired before it was decided.')).toBeTruthy();
  });

  it('without approval.approve, shows the list but no decision buttons', async () => {
    open('/approvals', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => p !== 'approval.approve');
    });
    await screen.findByText('Send a message');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('without approval.read, has no link, no page and reads nothing', async () => {
    const backend = open('/approvals', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => !p.startsWith('approval.'));
    });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('heading', { level: 1, name: 'Approvals' })).toBeNull();
    const sidebar = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(sidebar).queryByText('Approvals')).toBeNull();
    expect(approvalCalls(backend)).toHaveLength(0);
  });

  it('says when nothing is pending', async () => {
    open('/approvals', (b) => {
      b.options.approvals = { org_1: [] };
    });
    expect(await screen.findByText('Nothing is waiting for your approval.')).toBeTruthy();
  });
});
