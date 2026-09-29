import type { PageInput } from '@melonoffice/conversations';
import type { Contact, ContactId, OrganizationId } from '@melonoffice/domain';
import type { Context } from 'hono';

/**
 * Pages of Comercial's lists (ADR-0061): `?cursor=` is the `nextCursor` of the previous page and
 * `?limit=` how many records a page holds. The services check both against the organization of
 * the person asking; nothing here trusts them.
 */
export function pageOf(c: Context): PageInput {
  const cursor = c.req.query('cursor');
  const limit = c.req.query('limit');
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** Reads the contacts of one page by id, never the whole collection. */
export interface ContactsById {
  findContacts(
    organizationId: OrganizationId,
    ids: readonly ContactId[],
  ): Promise<readonly Contact[]>;
}

/** A contact's name as a list shows it: its name, else its phone, else its email. */
export const contactNames = (contacts: readonly Contact[]): ReadonlyMap<string, string | null> =>
  new Map(
    contacts.map((contact) => [
      contact.id as string,
      contact.displayName ?? contact.phone ?? contact.email ?? null,
    ]),
  );
