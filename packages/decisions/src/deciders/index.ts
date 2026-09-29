import type { Decider } from '../engine.js';
import { commercialPrioritiesDecider } from './commercial.js';
import { forecastSignalDecider } from './forecast.js';
import { policyCheckDecider } from './policy.js';
import { agentRoutingDecider } from './routing.js';

/** The decision types MelonMotor has today. Data: no code assumes how many exist. */
export const DECIDERS: readonly Decider<unknown>[] = Object.freeze([
  commercialPrioritiesDecider,
  policyCheckDecider,
  forecastSignalDecider,
  agentRoutingDecider,
]);
