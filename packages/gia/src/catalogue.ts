/**
 * What GIA's chat is allowed to say and point to (ADR-0052). GIA answers, explains and shows
 * where to go; she never acts. Every answer is one of these closed shapes.
 */

/** Screens of the app GIA may point to. `department` is a department's office. */
export const GIA_SCREENS = [
  'home',
  'gia',
  'conversations',
  'connections',
  'business_profile',
  'department',
  'none',
] as const;
export type GiaScreen = (typeof GIA_SCREENS)[number];

export const GIA_LOCALES = ['en', 'es'] as const;
export type GiaLocale = (typeof GIA_LOCALES)[number];

/** Hard bounds that keep one message cheap: at most 1 credit, whatever the plan. */
export const GIA_LIMITS = Object.freeze({
  messageLength: 2_000,
  /** Earlier turns of this chat the client may send back (the chat is not stored). */
  historyTurns: 6,
  historyLength: 2_000,
  answerLength: 2_000,
  proposedActionLength: 300,
  /** Facts GIA may propose to Company Brain from one message. */
  facts: 5,
  /** A fact below this confidence is not proposed. */
  factConfidence: 0.6,
  /** Company Brain facts given to the model for one message. */
  contextFacts: 25,
  /** Today's activity items given to the model. */
  activityItems: 20,
  outputTokens: 1_200,
  /** Links to Comercial one answer may carry (C4). */
  links: 4,
});

/**
 * Fixed-window request limits, per user and per organization, in this server's memory: a guard
 * against repeated clicks and runaway clients, like conversation assist's (ADR-0037). Credits
 * remain the real limit.
 */
export interface GiaRateLimits {
  readonly windowMs: number;
  readonly perUser: number;
  readonly perOrganization: number;
}

export const GIA_RATE_LIMITS: GiaRateLimits = Object.freeze({
  windowMs: 60_000,
  perUser: 20,
  perOrganization: 60,
});
