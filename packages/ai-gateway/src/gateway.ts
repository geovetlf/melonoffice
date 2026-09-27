import { actorOf, type AuditAction, type AuditModel, type AuditService } from '@melonoffice/audit';
import type {
  DeploymentEnvironment,
  Execution,
  ExecutionStatus,
  OrganizationId,
} from '@melonoffice/domain';
import { isExecutionId, type ExecutionRepository } from '@melonoffice/execution';
import { withCorrelation, type Logger } from '@melonoffice/observability';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { SpecialistService } from '@melonoffice/specialists';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { digestOf } from '@melonoffice/tools';
import {
  allowsFallback,
  isTransient,
  type ProviderCall,
  type ProviderErrorKind,
  type ProviderOutcome,
} from './adapter.js';
import { costMicroUsd, creditsFor, type CreditRate } from './cost.js';
import { creditReferenceOf, type AICreditsPort } from './credits.js';
import type { ModelPolicyCatalogue } from './policy.js';
import { modelKey, type ProviderRegistry } from './registry.js';
import {
  checkAIRequest,
  estimateInputTokens,
  inputModalitiesOf,
  type AIRequest,
} from './request.js';
import { checkProviderSuccess, type AIResponse } from './response.js';
import { routeModel, type RouteCandidate } from './router.js';

/**
 * The only way MelonOffice calls an AI model (ADR-0027):
 *
 *   AIRequest → validate → authorization → policy → route → credentials → adapter → response
 *   → usage → cost → credits → observability → audit.
 *
 * A specialist (and, later, GIA) never calls a provider directly. There is no client route to
 * the gateway: agents call it on the server, with the tenant of the user the work is for.
 */
export interface AIGateway {
  generate(tenant: TenantContext, request: AIRequest): Promise<AIResponse>;
}

export interface AIGatewayOptions {
  readonly executions: Pick<ExecutionRepository, 'find'>;
  /** Only `findOrganization` is used, to refuse inactive organizations. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly specialists: Pick<SpecialistService, 'eligibility' | 'getVersion'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly registry: ProviderRegistry;
  readonly policies: ModelPolicyCatalogue;
  /** Where this server runs, set explicitly. Undefined: every call is denied (fail closed). */
  readonly environment: DeploymentEnvironment | undefined;
  /**
   * The Credits engine and the credit rate (D-12). Either missing: every call is denied, so no
   * real model is ever used without being accounted for.
   */
  readonly credits?: { readonly port: AICreditsPort; readonly rate: CreditRate | undefined };
  readonly audit: AuditService;
  readonly logger?: Logger;
  /** How long one attempt may take. */
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Execution statuses in which a specialist may call a model. */
const WORKING: readonly ExecutionStatus[] = ['planning', 'running', 'verifying'];

type Attempt = ProviderOutcome | { readonly status: 'error'; readonly kind: 'timeout' };

function withDeadline(work: Promise<ProviderOutcome>, ms: number): Promise<Attempt> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Attempt>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'error', kind: 'timeout' }), Math.max(0, ms));
  });
  // An adapter that throws broke its contract: treated as an invalid response, never passed on.
  const outcome = work.catch((): Attempt => ({ status: 'error', kind: 'invalid_response' }));
  return Promise.race([outcome, timeout]).finally(() => clearTimeout(timer));
}

const REQUEST_ID = /^[\w-]{1,100}$/;

export function createAIGateway(options: AIGatewayOptions): AIGateway {
  const {
    executions,
    organizations,
    specialists,
    authorization,
    registry,
    policies,
    environment,
    credits,
    audit,
    timeoutMs = 60_000,
    now = () => new Date(),
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;
  const logger = options.logger ?? silent;

  async function organizationOf(tenant: TenantContext): Promise<OrganizationId | undefined> {
    if (!isResolvedTenant(tenant)) return undefined;
    const organization = await organizations.findOrganization(tenant.organizationId);
    return organization?.id === tenant.organizationId && organization.status === 'active'
      ? organization.id
      : undefined;
  }

  return Object.freeze({
    async generate(tenant: TenantContext, request: AIRequest): Promise<AIResponse> {
      const raw = request as unknown as Record<string, unknown> | null;
      const requestId =
        typeof raw?.requestId === 'string' && REQUEST_ID.test(raw.requestId)
          ? raw.requestId
          : 'invalid';
      const organizationId = await organizationOf(tenant);
      if (organizationId === undefined) {
        return deniedResponse(
          requestId,
          isResolvedTenant(tenant) ? 'organization_inactive' : 'unresolved_tenant',
        );
      }
      // Filled in as the request is checked, so that every audit event names what is known.
      const known: { execution?: Execution } = {};
      let model: AuditModel | undefined;
      let log = withCorrelation(logger, { requestId, organizationId });

      const record = async (
        action: Extract<AuditAction, `ai.${string}`>,
        reason: string,
        extra: { previousModel?: AuditModel } = {},
      ): Promise<void> => {
        await audit.record({
          action,
          result:
            action === 'ai.request_denied'
              ? 'denied'
              : action === 'ai.request_failed'
                ? 'failure'
                : 'success',
          actor: actorOf(tenant),
          organizationId,
          ...(known.execution === undefined
            ? {}
            : { target: { type: 'execution', id: known.execution.id } }),
          ...(model === undefined ? {} : { model }),
          ...(extra.previousModel === undefined ? {} : { previousModel: extra.previousModel }),
          reason,
          ...(requestId === 'invalid' ? {} : { requestId }),
          source: 'api',
        });
      };
      const deny = async (code: string): Promise<AIResponse> => {
        await record('ai.request_denied', code);
        log.info('ai request denied', { code });
        return deniedResponse(requestId, code);
      };

      // 1. Environment and the request itself.
      if (environment === undefined) return deny('environment_unknown');
      const problem = checkAIRequest(request);
      if (problem !== undefined) return deny(problem);

      // 2. Authorization: RBAC, then the execution and its specialist, read for this tenant.
      if (!authorization.authorize(tenant, 'ai.generate').allowed) {
        return deny('permission_denied');
      }
      const execution = isExecutionId(request.executionId)
        ? await executions.find(organizationId, request.executionId)
        : undefined;
      if (execution === undefined) return deny('execution_not_found');
      known.execution = execution;
      log = withCorrelation(log, {
        executionId: execution.id,
        ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }),
        specialistId: request.specialistId,
      });
      if (!WORKING.includes(execution.status)) return deny('execution_not_running');
      const { specialistId, specialistVersion, departmentId } = execution;
      if (
        specialistId === undefined ||
        specialistVersion === undefined ||
        departmentId === undefined
      ) {
        return deny('no_specialist');
      }
      // The specialist comes from the stored execution; a request naming another one is refused.
      if (specialistId !== request.specialistId) return deny('specialist_mismatch');
      const eligibility = await specialists.eligibility(tenant, {
        specialistId,
        departmentId,
        version: specialistVersion,
      });
      if (!eligibility.eligible) return deny('specialist_not_eligible');
      const version = await specialists.getVersion(tenant, specialistId, specialistVersion);

      // 3. Policy: the specialist's model policy, or the default.
      const policy = policies.resolve(version.configuration.policies.model);
      if (policy === undefined) return deny('policy_not_found');

      // 4. Credits must be able to account for the call before anything is sent.
      if (credits === undefined || credits.rate === undefined) {
        return deny('credits_not_configured');
      }
      const { port, rate } = credits;

      // 5. Route.
      const estimatedInputTokens = estimateInputTokens(request);
      const route = routeModel(registry, policy, environment, {
        capability: request.capability,
        inputModalities: inputModalitiesOf(request),
        outputModality: request.outputModality,
        ...(request.quality === undefined ? {} : { quality: request.quality }),
        ...(request.latency === undefined ? {} : { latency: request.latency }),
        ...(request.maxCostMicroUsd === undefined
          ? {}
          : { maxCostMicroUsd: request.maxCostMicroUsd }),
        sensitivity: request.sensitivity,
        estimatedInputTokens,
        maxOutputTokens: request.maxOutputTokens,
        ...(request.requirements?.minContextTokens === undefined
          ? {}
          : { minContextTokens: request.requirements.minContextTokens }),
        ...(request.requirements?.structuredOutput === undefined
          ? {}
          : { structuredOutput: request.requirements.structuredOutput }),
        ...(request.requirements?.toolUse === undefined
          ? {}
          : { toolUse: request.requirements.toolUse }),
        ...(request.requirements?.streaming === undefined
          ? {}
          : { streaming: request.requirements.streaming }),
      });
      if (route.status === 'none') return deny(route.reason);

      // Only models whose cost can be accounted for, within the request's credit limit.
      const creditsOf = (c: RouteCandidate) =>
        c.estimatedCostMicroUsd === undefined
          ? undefined
          : creditsFor(c.estimatedCostMicroUsd, rate);
      const priced = route.candidates.filter((c) => creditsOf(c) !== undefined);
      if (priced.length === 0) return deny('price_unknown');
      const affordable = priced.filter(
        (c) => request.maxCredits === undefined || (creditsOf(c) ?? Infinity) <= request.maxCredits,
      );
      if (affordable.length === 0) return deny('credit_limit_exceeded');
      const balance = await port.balanceOf(tenant);
      if (balance.status !== 'present') return deny('credits_unavailable');
      const covered = affordable.filter((c) => (creditsOf(c) ?? Infinity) <= balance.balance);
      if (covered.length === 0) return deny('credits_insufficient');
      // The chosen model first; the others only when the policy allows a fallback.
      const candidates = policy.fallback === 'compatible' ? covered : covered.slice(0, 1);

      // 6. Call, with retries on transient errors and fallback when allowed.
      const idempotencyKey = digestOf({ organizationId, requestId: request.requestId });
      const started = performance.now();
      let attempts = 0;
      let lastKind: ProviderErrorKind = 'unavailable';
      let previous: AuditModel | undefined;
      const [first] = candidates;
      for (const candidate of candidates) {
        model = { provider: candidate.provider.id, id: candidate.model.modelId };
        const key = modelKey(candidate.provider.id, candidate.model.modelId);
        const callLog = withCorrelation(log, { provider: model.provider, model: key });
        if (previous !== undefined) {
          await record('ai.provider_fallback', lastKind, { previousModel: previous });
          callLog.warn('ai provider fallback', { from: modelKey(previous.provider, previous.id) });
        }
        for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
          attempts += 1;
          const call: ProviderCall = Object.freeze({
            requestId: request.requestId,
            idempotencyKey,
            model: Object.freeze({ id: candidate.model.modelId, version: candidate.model.version }),
            capability: request.capability,
            messages: request.messages,
            outputModality: request.outputModality,
            maxOutputTokens: request.maxOutputTokens,
            structuredOutput: request.requirements?.structuredOutput ?? false,
            credential: candidate.provider.credential,
            deadline: new Date(now().getTime() + timeoutMs),
          });
          let outcome = await withDeadline(candidate.adapter.generate(call), timeoutMs);
          if (outcome.status === 'success' && !checkProviderSuccess(outcome)) {
            outcome = { status: 'error', kind: 'invalid_response' };
          }
          if (outcome.status === 'success') {
            const latencyMs = Math.round(performance.now() - started);
            const actual = costMicroUsd(candidate.model.pricing, outcome.usage) ?? 0;
            const charge = creditsFor(actual, rate);
            if (charge > 0) {
              try {
                await port.consume(tenant, {
                  amount: charge,
                  referenceId: creditReferenceOf(request.requestId),
                  reason: 'ai_generation',
                });
              } catch {
                // The answer is not passed on when it cannot be accounted for.
                await record('ai.request_failed', 'credits_charge_failed');
                callLog.error('ai credits charge failed', { attempts, latencyMs });
                return failedResponse(
                  requestId,
                  'credits_charge_failed',
                  model,
                  attempts,
                  latencyMs,
                );
              }
            }
            callLog.info('ai request completed', {
              status: 'completed',
              attempts,
              latencyMs,
              // Usage is logged as units: the logger redacts any key named like a token.
              inputUnits: outcome.usage.inputTokens,
              outputUnits: outcome.usage.outputTokens,
              costMicroUsd: actual,
              credits: charge,
            });
            return Object.freeze({
              status: 'completed',
              requestId,
              provider: candidate.provider.id,
              model: candidate.model.modelId,
              versions: Object.freeze({
                adapter: candidate.adapter.adapterVersion,
                model: candidate.model.version,
                policy: Object.freeze({ id: policy.id, version: policy.version }),
              }),
              output: outcome.output,
              usage: Object.freeze({ ...outcome.usage }),
              latencyMs,
              finishReason: outcome.finishReason,
              cost: Object.freeze({
                estimatedMicroUsd: candidate.estimatedCostMicroUsd ?? null,
                actualMicroUsd: actual,
              }),
              credits: Object.freeze({
                state: charge > 0 ? 'consumed' : 'free',
                estimated: creditsOf(candidate) ?? null,
                consumed: charge,
              }),
              providerRequestId: outcome.providerRequestId ?? null,
              attempts,
              fallbackFrom:
                first === undefined || candidate === first
                  ? null
                  : modelKey(first.provider.id, first.model.modelId),
            });
          }
          lastKind = outcome.kind;
          callLog.warn('ai provider error', { kind: outcome.kind, attempt });
          // Permanent errors are never retried on the same model.
          if (!isTransient(outcome.kind) || attempt === policy.maxAttempts) break;
          await sleep(policy.backoffMs * attempt);
        }
        // A request the provider refused would be refused elsewhere too: no fallback.
        if (!allowsFallback(lastKind)) break;
        previous = model;
      }
      const latencyMs = Math.round(performance.now() - started);
      await record('ai.request_failed', lastKind);
      log.error('ai request failed', { kind: lastKind, attempts, latencyMs });
      return failedResponse(requestId, lastKind, model, attempts, latencyMs);
    },
  });
}

const deniedResponse = (requestId: string, code: string): AIResponse =>
  Object.freeze({ status: 'denied', requestId, code });

const failedResponse = (
  requestId: string,
  code: string,
  model: AuditModel | undefined,
  attempts: number,
  latencyMs: number,
): AIResponse =>
  Object.freeze({
    status: 'failed',
    requestId,
    code,
    provider: model?.provider ?? null,
    model: model?.id ?? null,
    attempts,
    latencyMs,
  });

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};
