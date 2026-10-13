import type { InvoicingConnection, InvoicingRecordType } from '@melonoffice/domain';
import { isIntegrationError } from '../errors.js';
import {
  checkInvoicingAdapter,
  type InvoicingAdapter,
  type InvoicingCredentials,
} from './contract.js';
import { checkNormalizedRecord, digestOf } from './model.js';

/**
 * The contract tests every invoicing adapter passes before it is registered (ADR-0193): against
 * a double in CI, and against the provider's sandbox or a real account before a connector is
 * called operational. Pure: it returns what is wrong, so any test runner can assert it is empty.
 */
export interface InvoicingContractFixture {
  readonly connection: InvoicingConnection;
  readonly credentials: InvoicingCredentials;
  /** Credentials the provider refuses. */
  readonly refusedCredentials: InvoicingCredentials;
  /** A valid account as a person would configure it. */
  readonly account: unknown;
  readonly webhook?: {
    readonly rawBody: string;
    readonly headers: Headers;
    readonly secret: string;
  };
  /** The most pages a full read may take. */
  readonly maxPages?: number;
}

const PROVIDER_CODES = new Set(['provider_unavailable', 'provider_rejected']);

export async function checkInvoicingAdapterContract(
  adapter: InvoicingAdapter,
  fixture: InvoicingContractFixture,
): Promise<readonly string[]> {
  const problems: string[] = [];
  const note = (problem: string) => problems.push(problem);
  try {
    checkInvoicingAdapter(adapter);
  } catch (error) {
    note(`adapter: ${(error as Error).message}`);
    return problems;
  }

  // The account: public fields only. A secret or an unknown field is refused.
  try {
    adapter.checkAccount(fixture.account);
  } catch {
    note('checkAccount refuses a valid account');
  }
  for (const extra of [
    { password: 'x' },
    { claveSol: 'x' },
    { token: 'x' },
    { unknownField: 'x' },
  ]) {
    try {
      adapter.checkAccount({ ...(fixture.account as object), ...extra });
      note(`checkAccount accepts ${Object.keys(extra)[0]}`);
    } catch (error) {
      if (!isIntegrationError(error) || error.code !== 'invalid_connection') {
        note('checkAccount refuses with something other than invalid_connection');
      }
    }
  }

  // Credentials: a check answers, it does not throw.
  try {
    const good = await adapter.validateConnection(fixture.connection, fixture.credentials);
    if (good.status !== 'valid') note('validateConnection refuses valid credentials');
    const bad = await adapter.validateConnection(fixture.connection, fixture.refusedCredentials);
    if (bad.status !== 'invalid') note('validateConnection accepts refused credentials');
  } catch {
    note('validateConnection throws');
  }

  // Every declared record type reads to the end, page by page, normalized and stable.
  const maxPages = fixture.maxPages ?? 50;
  for (const recordType of adapter.capabilities.records as readonly InvoicingRecordType[]) {
    const seen = new Set<string>();
    const digests: string[] = [];
    let cursor: string | undefined;
    let watermark: string | undefined;
    let pages = 0;
    try {
      do {
        const page = await adapter.listPage(fixture.connection, fixture.credentials, {
          recordType,
          ...(cursor === undefined ? {} : { cursor }),
          pageSize: Math.min(2, adapter.capabilities.maxPageSize),
          timeoutMs: 5_000,
        });
        pages += 1;
        if (page.records.length > Math.min(2, adapter.capabilities.maxPageSize)) {
          note(`${recordType}: page larger than asked`);
        }
        if (!Number.isSafeInteger(page.bytes) || page.bytes < 0) note(`${recordType}: bytes`);
        for (const record of page.records) {
          try {
            checkNormalizedRecord(record, recordType);
          } catch (error) {
            note(
              `${recordType}: invalid record (${isIntegrationError(error) ? error.detail : 'unknown'})`,
            );
          }
          if (seen.has(record.externalId)) note(`${recordType}: ${record.externalId} read twice`);
          seen.add(record.externalId);
          digests.push(digestOf(record.original.content));
        }
        cursor = page.nextCursor;
        if (page.watermark !== undefined) watermark = page.watermark;
      } while (cursor !== undefined && pages < maxPages);
      if (cursor !== undefined) note(`${recordType}: more than ${maxPages} pages`);
      if (adapter.capabilities.incrementalSync && watermark === undefined) {
        note(`${recordType}: incremental without a watermark`);
      }
      // Reading again gives the same originals: digests are what tell a change from a re-read.
      const again = await adapter.listPage(fixture.connection, fixture.credentials, {
        recordType,
        pageSize: Math.min(2, adapter.capabilities.maxPageSize),
        timeoutMs: 5_000,
      });
      again.records.forEach((record, i) => {
        if (digestOf(record.original.content) !== digests[i]) {
          note(`${recordType}: original changed between two reads`);
        }
      });
    } catch (error) {
      note(
        `${recordType}: listPage threw ${isIntegrationError(error) ? error.code : 'a non-integration error'}`,
      );
    }
    try {
      await adapter.listPage(fixture.connection, fixture.refusedCredentials, {
        recordType,
        pageSize: 1,
        timeoutMs: 5_000,
      });
      note(`${recordType}: listPage reads with refused credentials`);
    } catch (error) {
      if (!isIntegrationError(error) || !PROVIDER_CODES.has(error.code)) {
        note(`${recordType}: refused credentials throw a non-provider error`);
      }
    }
  }

  // Webhooks: a forged body is refused; a real one names its event.
  if (adapter.capabilities.webhooks && fixture.webhook !== undefined) {
    const { rawBody, headers, secret } = fixture.webhook;
    if (adapter.verifyWebhook?.(rawBody, headers, secret) !== true) {
      note('verifyWebhook refuses a signed body');
    }
    if (adapter.verifyWebhook?.(`${rawBody} `, headers, secret) !== false) {
      note('verifyWebhook accepts a changed body');
    }
    if (adapter.verifyWebhook?.(rawBody, headers, `${secret}x`) !== false) {
      note('verifyWebhook accepts another secret');
    }
    try {
      const hint = adapter.parseWebhook?.(rawBody);
      if (hint === undefined || hint.eventId.length === 0) note('parseWebhook without an event id');
    } catch {
      note('parseWebhook throws on a signed body');
    }
  }
  return problems;
}
