import type { IsoTimestamp, OrganizationId } from './ids.js';

/**
 * The four kinds of context MelonOffice keeps apart (ADR-0029). Each has its own owner, lifetime
 * and access rules, and none is a copy of another:
 *
 * - `company`: what the organization is and how it works. Owned by the organization, changes
 *   slowly, versioned.
 * - `conversation`: what was said in one conversation. Conversation memory, not company facts.
 * - `execution`: what one execution was given and produced. Lives with the execution.
 * - `user_personal`: one user's own preferences. Never shared with the organization.
 */
export type ContextKind = 'company' | 'conversation' | 'execution' | 'user_personal';

/**
 * The parts a Company Context is made of, filled in progressively. Only the contract exists:
 * there is no Context Engine yet, and nothing reads or writes these sections today.
 */
export type CompanyContextSection =
  | 'identity'
  | 'description'
  | 'industry'
  | 'products'
  | 'services'
  | 'goals'
  | 'priorities'
  | 'structure'
  | 'departments'
  | 'processes'
  | 'internal_policies'
  | 'preferences'
  | 'markets'
  | 'customers'
  | 'constraints'
  | 'relevant_documents'
  | 'knowledge';

/**
 * A pointer to one immutable version of an organization's Company Context. An execution
 * receives it as a `company_context` component of its version snapshot, so it always knows
 * exactly which company facts it ran with; the facts themselves stay in the context store.
 */
export interface CompanyContextRef {
  readonly kind: 'company_context';
  readonly id: string;
  readonly version: string;
}

/**
 * One version of a Company Context as the future Context Engine will hand it out: sections point
 * at stored content, never carry it, like every other reference in an execution.
 */
export interface CompanyContextSnapshot {
  readonly schemaVersion: 1;
  readonly organizationId: OrganizationId;
  readonly ref: CompanyContextRef;
  readonly createdAt: IsoTimestamp;
  readonly sections: Readonly<
    Partial<Record<CompanyContextSection, { readonly type: string; readonly id: string }>>
  >;
}
