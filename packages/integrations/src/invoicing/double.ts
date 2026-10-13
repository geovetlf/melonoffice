import type {
  IntegrationProviderId,
  InvoicingAccount,
  InvoicingCapabilities,
  InvoicingRecordType,
} from '@melonoffice/domain';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { IntegrationError, type IntegrationErrorCode } from '../errors.js';
import type { InvoicingAdapter, NormalizedInvoicingRecord } from './contract.js';

/**
 * A provider double for tests only (ADR-0193): an invoicing provider kept in memory, with the
 * failures a real one has (unavailable, rate limited, credentials refused), signed webhooks and
 * a JSON export. It is not registered anywhere outside tests and is never a connector.
 */

export const DOUBLE_TOKEN = 'double-token-valid';
export const DOUBLE_HEADER = 'x-double-signature';

export interface DoubleRecord {
  readonly record: NormalizedInvoicingRecord;
  /** When it last changed at the provider, as a sequence: the watermark. */
  readonly changedAt: number;
}

export interface InvoicingDouble {
  /** The adapter, as the registry sees it: nothing but the contract. */
  readonly adapter: InvoicingAdapter;
  /** Puts or changes a record, as the provider would. */
  put(record: NormalizedInvoicingRecord, changedAt: number): void;
  /** The next `times` provider calls fail this way. */
  failNext(
    times: number,
    code: Extract<IntegrationErrorCode, 'provider_unavailable' | 'provider_rejected'>,
    detail: string,
    retryAfterMs?: number,
  ): void;
  readonly calls: { listPage: number; validate: number; revoke: number };
}

const ACCOUNT_FIELDS = new Set(['taxId', 'companyId']);

export function createInvoicingDouble(
  options: {
    readonly provider?: string;
    readonly capabilities?: Partial<InvoicingCapabilities>;
  } = {},
): InvoicingDouble {
  const store = new Map<string, DoubleRecord>();
  let failures: {
    times: number;
    code: IntegrationErrorCode;
    detail: string;
    retryAfterMs?: number;
  } = {
    times: 0,
    code: 'provider_unavailable',
    detail: 'no_answer',
  };
  const calls = { listPage: 0, validate: 0, revoke: 0 };
  const capabilities: InvoicingCapabilities = Object.freeze({
    records: ['party', 'document', 'payment'] as InvoicingRecordType[],
    incrementalSync: true,
    webhooks: true,
    fileImport: ['provider_csv'] as const,
    authorityStatus: true,
    paymentConfirmation: true,
    revokeOnDisconnect: true,
    maxPageSize: 100,
    ...options.capabilities,
    write: [] as [],
  });

  const maybeFail = () => {
    if (failures.times > 0) {
      failures = { ...failures, times: failures.times - 1 };
      throw new IntegrationError(failures.code, failures.detail, failures.retryAfterMs);
    }
  };
  const authorized = (values: Readonly<Record<string, string>>) => {
    if (values.api_token !== DOUBLE_TOKEN) {
      throw new IntegrationError('provider_rejected', 'unauthorized');
    }
  };
  const sign = (body: string, secret: string) =>
    createHmac('sha256', secret).update(body).digest('hex');

  const adapter: InvoicingAdapter = {
    provider: (options.provider ?? 'double_invoicing') as IntegrationProviderId,
    category: 'invoicing',
    jurisdictions: ['PE', 'MX'],
    capabilities,
    credentialKinds: ['api_token', 'webhook_secret'],
    checkAccount(value: unknown): InvoicingAccount {
      if (typeof value !== 'object' || value === null) {
        throw new IntegrationError('invalid_connection', 'account');
      }
      const entries = Object.entries(value as Record<string, unknown>);
      for (const [k, v] of entries) {
        if (!ACCOUNT_FIELDS.has(k) || typeof v !== 'string' || !/^[A-Za-z0-9-]{1,32}$/.test(v)) {
          throw new IntegrationError('invalid_connection', `account.${k}`);
        }
      }
      if (!entries.some(([k]) => k === 'taxId')) {
        throw new IntegrationError('invalid_connection', 'account.taxId');
      }
      return Object.freeze(Object.fromEntries(entries)) as InvoicingAccount;
    },
    accountIdOf: (account) => account.taxId as string,
    async validateConnection(_connection, credentials) {
      calls.validate += 1;
      return credentials.values.api_token === DOUBLE_TOKEN
        ? { status: 'valid' }
        : { status: 'invalid', code: 'unauthorized' };
    },
    async listPage(_connection, credentials, request) {
      calls.listPage += 1;
      maybeFail();
      authorized(credentials.values);
      const since = request.since === undefined ? -1 : Number(request.since);
      const all = [...store.values()]
        .filter((r) => r.record.recordType === request.recordType && r.changedAt > since)
        .sort((a, b) => (a.record.externalId < b.record.externalId ? -1 : 1));
      const offset = request.cursor === undefined ? 0 : Number(request.cursor.slice(2));
      const records = all.slice(offset, offset + request.pageSize).map((r) => r.record);
      const next = offset + request.pageSize;
      const watermark = String(Math.max(since, ...all.map((r) => r.changedAt)));
      return {
        records,
        ...(next < all.length ? { nextCursor: `o:${next}` } : {}),
        watermark,
        bytes: records.reduce((n, r) => n + Buffer.byteLength(r.original.content), 0),
      };
    },
    verifyWebhook(rawBody, headers, secret) {
      const given = headers.get(DOUBLE_HEADER) ?? '';
      const expected = sign(rawBody, secret);
      return (
        given.length === expected.length &&
        timingSafeEqual(Buffer.from(given), Buffer.from(expected))
      );
    },
    parseWebhook(rawBody) {
      try {
        const body = JSON.parse(rawBody) as { id?: unknown; types?: unknown };
        if (typeof body.id !== 'string' || !Array.isArray(body.types)) throw new Error('shape');
        return { eventId: body.id, recordTypes: body.types as InvoicingRecordType[] };
      } catch {
        throw new IntegrationError('invalid_payload', 'webhook');
      }
    },
    readFile(_format, content) {
      try {
        const records = JSON.parse(
          Buffer.from(content).toString('utf8'),
        ) as NormalizedInvoicingRecord[];
        if (!Array.isArray(records)) throw new Error('shape');
        return { records, bytes: content.byteLength };
      } catch {
        throw new IntegrationError('invalid_file', 'unreadable');
      }
    },
    async revokeAccess() {
      calls.revoke += 1;
    },
  };
  return {
    adapter,
    put(record, changedAt) {
      store.set(`${record.recordType}:${record.externalId}`, { record, changedAt });
    },
    failNext(times, code, detail, retryAfterMs) {
      failures = { times, code, detail, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
    },
    calls,
  };
}

/** Signs a webhook body the way the double's provider does. */
export const signDoubleWebhook = (body: string, secret: string): Headers =>
  new Headers({ [DOUBLE_HEADER]: createHmac('sha256', secret).update(body).digest('hex') });
