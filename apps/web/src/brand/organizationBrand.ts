import type { ReplyRequest } from '../conversations/sendReply.js';
import type { OwnBrand } from '../commercial/consoleClient.js';
import { parsePublicBrand, type PublicBrand } from './brand.js';

/**
 * An organization's brand through the API (ADR-0087, ADR-0090): what its people see, merged from
 * the platform, its white-label partner and its own level, and its own level, which only its
 * owner changes.
 */

export interface OrganizationBrand extends OwnBrand {
  /** What its people see; `undefined` while only the platform's applies. */
  readonly shown: PublicBrand | undefined;
}

export interface OrganizationBrandClient {
  read(): Promise<OrganizationBrand>;
  save(
    config: Readonly<Record<string, unknown>>,
    expectedUpdatedAt: string | null,
  ): Promise<OwnBrand>;
}

export class BrandRequestError extends Error {
  override readonly name = 'BrandRequestError';
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly field?: string,
  ) {
    super(`brand request failed: ${status}`);
  }
}

export function createOrganizationBrandClient(
  request: ReplyRequest,
  organizationId: string,
): OrganizationBrandClient {
  const path = `/v1/organizations/${encodeURIComponent(organizationId)}/brand`;
  const parse = async (response: Response) => {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new BrandRequestError(
        response.status,
        typeof body.error === 'string' ? body.error : undefined,
        typeof body.field === 'string' ? body.field : undefined,
      );
    }
    return body;
  };
  return {
    async read() {
      const body = await parse(await request(path, {}));
      const levels = Array.isArray(body.levels) ? body.levels : [];
      return {
        own: (body.own ?? null) as OwnBrand['own'],
        updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : null,
        // Only a stored level changes the look: the platform's own brand is the app as built.
        shown:
          levels.length === 0
            ? undefined
            : parsePublicBrand({ context: 'organization', brand: body.brand }),
      };
    },
    async save(config, expectedUpdatedAt) {
      const body = await parse(
        await request(path, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            config,
            ...(expectedUpdatedAt === null ? {} : { expectedUpdatedAt }),
          }),
        }),
      );
      return {
        own: (body.config ?? null) as OwnBrand['own'],
        updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : null,
      };
    },
  };
}
