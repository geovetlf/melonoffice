import type { OrganizationId } from '@melonoffice/domain';
import type { Logger } from '@melonoffice/observability';
import type { EventSubscriber } from './bus.js';
import { EVENT_CATALOGUE, type EventDefinition } from './catalogue.js';
import type { DomainEvent } from './model.js';

/**
 * EVENT → TRIGGER → WORKFLOW or AGENT TASK (EV-2, ADR-0067). The one place an event can start
 * work. It starts nothing by itself: an organization's triggers say which of its workflows or
 * agents an event type starts, and each target is started by the engine that owns it (Workflow
 * Engine, Agent Engine), with that engine's own permissions, approvals and audit. There is no
 * second workflow engine here and no autonomy: with no triggers, an event starts nothing.
 */
export type TriggerTargetKind = 'workflow' | 'agent';

export interface EventTrigger {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly eventType: string;
  readonly target: { readonly kind: TriggerTargetKind; readonly id: string };
}

/** Starts one target for one event. It dedupes on `idempotencyKey`: an event starts it once. */
export interface TriggerStarter {
  start(event: DomainEvent, trigger: EventTrigger, idempotencyKey: string): Promise<void>;
}

export interface TriggerRouterOptions {
  /** The organization's triggers for an event type, read from the store that owns them. */
  readonly triggers: (
    organizationId: OrganizationId,
    eventType: string,
  ) => Promise<readonly EventTrigger[]>;
  /** The engines that start each kind of target; a kind without one is skipped, and logged. */
  readonly starters: Partial<Record<TriggerTargetKind, TriggerStarter>>;
  readonly catalogue?: readonly EventDefinition[];
  readonly logger?: Logger;
}

export const TRIGGER_ROUTER_ID = 'triggers.router';

export function createTriggerRouter(options: TriggerRouterOptions): EventSubscriber {
  const { triggers, starters, logger } = options;
  return Object.freeze({
    id: TRIGGER_ROUTER_ID,
    types: Object.freeze((options.catalogue ?? EVENT_CATALOGUE).map((d) => d.type)),
    async handle(event: DomainEvent) {
      for (const trigger of await triggers(event.organizationId, event.type)) {
        // Only this organization's triggers for this type, whatever the store returned.
        if (trigger.organizationId !== event.organizationId || trigger.eventType !== event.type) {
          logger?.warn('events.trigger_refused', { eventId: event.id, triggerId: trigger.id });
          continue;
        }
        const starter = starters[trigger.target.kind];
        if (starter === undefined) {
          logger?.warn('events.trigger_target_unavailable', {
            eventId: event.id,
            triggerId: trigger.id,
            kind: trigger.target.kind,
          });
          continue;
        }
        await starter.start(event, trigger, `${event.id}:${trigger.id}`);
        logger?.info('events.trigger_started', {
          eventId: event.id,
          triggerId: trigger.id,
          kind: trigger.target.kind,
        });
      }
    },
  });
}
