import type {
  IsoTimestamp,
  MessageKey,
  OrganizationId,
  Pipeline,
  PipelineId,
  PipelineStage,
} from '@melonoffice/domain';
import { ConversationError } from './errors.js';

/**
 * The sales pipeline (C2, ADR-0054): an organization's own stages. Businesses do not all sell the
 * same way, so the stages a new organization is offered come from a template for its kind of
 * business (from Company Brain), and the organization can rename, add, reorder and remove its
 * open stages. Every pipeline ends in exactly one `won` and one `lost` stage.
 */

export const PIPELINE_LIMITS = Object.freeze({
  openStages: 12,
  stageNameLength: 40,
});

export const WON_STAGE = 'won';
export const LOST_STAGE = 'lost';

// Letters and underscores only: a stage id is also an audit transition code.
const STAGE_ID = /^[a-z][a-z_]{0,31}$/;

/** A new stage's id: `stage_` and eight random letters. */
export function newStageId(random: () => number = Math.random): string {
  let letters = '';
  for (let i = 0; i < 8; i += 1) letters += String.fromCharCode(97 + Math.floor(random() * 26));
  return `stage_${letters}`;
}

export const isStageId = (value: unknown): value is string =>
  typeof value === 'string' && STAGE_ID.test(value);

/** The one pipeline an organization has in C2. The model allows more later. */
export const pipelineIdFor = (organizationId: OrganizationId): PipelineId =>
  `${organizationId}_default` as PipelineId;

const key = (id: string) => `pipeline.stage.${id}` as MessageKey;

/** A template's open stages, each with its default chance of closing. */
type Template = readonly (readonly [id: string, probability: number])[];

const GENERAL: Template = [
  ['new', 10],
  ['contacted', 25],
  ['proposal', 50],
  ['negotiation', 75],
];
const SERVICES: Template = [
  ['inquiry', 10],
  ['meeting', 30],
  ['proposal', 50],
  ['negotiation', 75],
];

/**
 * The stages each kind of business starts with (ADR-0054). Data, not rules: a kind without its
 * own uses `general`, and every organization can change its stages afterwards.
 */
export const PIPELINE_TEMPLATES: Readonly<Record<string, Template>> = Object.freeze({
  general: GENERAL,
  restaurant: [
    ['inquiry', 20],
    ['quote', 50],
    ['confirmation', 80],
  ],
  store: [
    ['interested', 20],
    ['quote', 50],
    ['closing', 80],
  ],
  ecommerce: [
    ['inquiry', 20],
    ['pending_payment', 70],
  ],
  professional_services: SERVICES,
  consulting: SERVICES,
  agency: SERVICES,
  beauty_salon: [
    ['inquiry', 30],
    ['appointment', 70],
  ],
  workshop: [
    ['diagnosis', 20],
    ['quote', 50],
    ['approval', 80],
  ],
  distributor: [
    ['contacted', 10],
    ['quote', 30],
    ['trial_order', 60],
    ['negotiation', 80],
  ],
});

export const templateFor = (businessType: string | undefined): string =>
  businessType !== undefined && Object.hasOwn(PIPELINE_TEMPLATES, businessType)
    ? businessType
    : 'general';

const closing = (): PipelineStage[] => [
  Object.freeze({ id: WON_STAGE, kind: 'won', nameKey: key(WON_STAGE), probability: 100 }),
  Object.freeze({ id: LOST_STAGE, kind: 'lost', nameKey: key(LOST_STAGE), probability: 0 }),
];

/** The pipeline a kind of business is offered: not stored until the organization accepts it. */
export function proposedPipeline(
  organizationId: OrganizationId,
  businessType: string | undefined,
  at: IsoTimestamp,
): Pipeline {
  const template = templateFor(businessType);
  const open = (PIPELINE_TEMPLATES[template] ?? GENERAL).map(([id, probability]) =>
    Object.freeze({ id, kind: 'open' as const, nameKey: key(id), probability }),
  );
  return Object.freeze({
    id: pipelineIdFor(organizationId),
    organizationId,
    stages: Object.freeze([...open, ...closing()]),
    template,
    revision: 0,
    createdAt: at,
    updatedAt: at,
  });
}

export const stageOf = (pipeline: Pick<Pipeline, 'stages'>, id: string) =>
  pipeline.stages.find((stage) => stage.id === id);

const bad = (field: string): never => {
  throw new ConversationError('invalid_request', field);
};

const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A new name replaces the template's key; without one, the stage keeps what it had. */
function stageName(
  existing: PipelineStage | undefined,
  name: string | undefined,
): { readonly name?: string; readonly nameKey?: MessageKey } {
  if (name !== undefined) return { name };
  if (existing?.name !== undefined) return { name: existing.name };
  return existing?.nameKey === undefined ? {} : { nameKey: existing.nameKey };
}

/**
 * The stages a person sends, checked against the current ones: open stages in order (1 to 12),
 * each an existing id (keeping its name unless renamed) or a new one with a name; `won` and
 * `lost` are always the last two and cannot be removed. Their probabilities stay 100 and 0.
 */
export function checkStages(
  current: readonly PipelineStage[],
  input: unknown,
  newStageId: () => string,
): readonly PipelineStage[] {
  if (!Array.isArray(input)) return bad('stages');
  const known = new Map(current.map((stage) => [stage.id, stage]));
  const open: PipelineStage[] = [];
  const closed: PipelineStage[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of (input as unknown[]).entries()) {
    const field = `stages.${index}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad(field);
    const entry = raw as Record<string, unknown>;
    for (const k of Object.keys(entry)) {
      if (!['id', 'name', 'probability'].includes(k)) bad(`${field}.${k}`);
    }
    const existing = entry.id === undefined ? undefined : known.get(entry.id as string);
    if (entry.id !== undefined && existing === undefined) bad(`${field}.id`);
    const id = existing?.id ?? newStageId();
    if (seen.has(id)) bad(`${field}.id`);
    seen.add(id);
    let name: string | undefined;
    if (entry.name !== undefined) {
      if (typeof entry.name !== 'string') return bad(`${field}.name`);
      const trimmed = entry.name.normalize('NFC').trim();
      if (
        trimmed === '' ||
        [...trimmed].length > PIPELINE_LIMITS.stageNameLength ||
        CONTROL.test(trimmed)
      ) {
        bad(`${field}.name`);
      }
      name = trimmed;
    }
    if (existing === undefined && name === undefined) bad(`${field}.name`);
    const kind = existing?.kind ?? 'open';
    if (kind !== 'open') {
      if (entry.probability !== undefined) bad(`${field}.probability`);
      closed.push(
        Object.freeze({
          ...stageName(existing, name),
          id,
          kind,
          probability: existing?.probability ?? 0,
        }),
      );
      continue;
    }
    if (closed.length > 0) bad(field); // Open stages come before won and lost.
    const probability = entry.probability ?? existing?.probability;
    if (!isProbability(probability)) return bad(`${field}.probability`);
    open.push(Object.freeze({ ...stageName(existing, name), id, kind: 'open', probability }));
  }
  if (open.length === 0 || open.length > PIPELINE_LIMITS.openStages) bad('stages');
  if (closed.length !== 2 || closed[0]?.kind !== 'won' || closed[1]?.kind !== 'lost') {
    bad('stages');
  }
  return Object.freeze([...open, ...closed]);
}
