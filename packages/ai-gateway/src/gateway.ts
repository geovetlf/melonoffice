import {
  actorOf,
  type AuditAction,
  type AuditModel,
  type AuditService,
  type AuditTarget,
} from '@melonoffice/audit';
import type {
  DeploymentEnvironment,
  ExecutionStatus,
  ModelPolicy,
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
  checkAssistedAIRequest,
  estimateInputTokens,
  inputModalitiesOf,
  type AIModelRequest,
  type AIRequest,
  type AssistedAIRequest,
  type AssistSubjectType,
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
  /**
   * An assisted call (ADR-0037): a person, acting directly, asks about one record they can read.
   * No execution or specialist is involved, so none is required; everything from the policy on
   * (credits, routing, the provider call, cost and audit) is the same code as `generate`. The
   * caller must already have read the subject for this tenant: the gateway checks who asks and
   * the subject's permission, and never reads the subject itself.
   */
  assist(tenant: TenantContext, request: AssistedAIRequest): Promise<AIResponse>;
}

/**
 * The permission an assisted call about each kind of subject needs (ADR-0037). Fixed here, so a
 * caller cannot pick a weaker one. Reading the subject is checked by the caller as well.
 */
export const ASSIST_PERMISSIONS: Readonly<Record<AssistSubjectType, string>> = Object.freeze({
  conversation: 'conversation.assist',
  // Extracting Company Brain facts from what a person gives (ADR-0051).
  company_knowledge: 'knowledge.capture',
});

/**
 * The model policy an assisted call about each kind of subject uses (ADR-0038). Fixed here, like
 * its permission: a person cannot pick another. Each is its own named policy, never the default,
 * so allowing a subject's data (a conversation is `confidential`) to reach a model is an explicit
 * decision about that subject and those models only. A missing policy denies the call.
 */
export const ASSIST_MODEL_POLICIES: Readonly<
  Record<AssistSubjectType, { readonly id: string; readonly version: number }>
> = Object.freeze({
  conversation: Object.freeze({ id: 'conversation_assist', version: 1 }),
  company_knowledge: Object.freeze({ id: 'company_knowledge_assist', version: 1 }),
});

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

  /** One call's audit and log context, filled in as the request is checked. */
  function callContext(tenant: TenantContext, organizationId: OrganizationId, requestId: string) {
    const known: { target?: AuditTarget; model?: AuditModel } = {};
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
        ...(known.target === undefined ? {} : { target: known.target }),
        ...(known.model === undefined ? {} : { model: known.model }),
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
    return {
      tenant,
      requestId,
      known,
      record,
      deny,
      get log() {
        return log;
      },
      correlate(correlation: Parameters<typeof withCorrelation>[1]) {
        log = withCorrelation(log, correlation);
      },
    };
  }
  type CallContext = ReturnType<typeof callContext>;

  /** The id to answer with: the request's own when well-formed, `invalid` otherwise. */
  const requestIdOf = (request: unknown): string => {
    const raw = request as Record<string, unknown> | null;
    return typeof raw?.requestId === 'string' && REQUEST_ID.test(raw.requestId)
      ? raw.requestId
      : 'invalid';
  };

  /**
   * Everything after authorization and policy, the same for every caller: credits must be able to
   * account for the call, then route, call with retries and fallback, charge, log and answer.
   */
  async function callModel(
    ctx: CallContext,
    request: AIModelRequest,
    policy: ModelPolicy,
  ): Promise<AIResponse> {
    const { tenant, requestId, known, record, deny } = ctx;
    // environment is checked by every caller before this point.
    const deployment = environment as DeploymentEnvironment;
    const organizationId = tenant.organizationId;
    const log = ctx.log;

    // 4. Credits must be able to account for the call before anything is sent.
    if (credits === undefined || credits.rate === undefined) {
      return deny('credits_not_configured');
    }
    const { port, rate } = credits;
    // 5. Route.
    const estimatedInputTokens = estimateInputTokens(request);
    const route = routeModel(registry, policy, deployment, {
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
      c.estimatedCostMicroUsd === undefined ? undefined : creditsFor(c.estimatedCostMicroUsd, rate);
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
      known.model = { provider: candidate.provider.id, id: candidate.model.modelId };
      const model = known.model;
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
          ...(request.outputSchema === undefined ? {} : { outputSchema: request.outputSchema }),
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
              return failedResponse(requestId, 'credits_charge_failed', model, attempts, latencyMs);
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
      previous = known.model;
    }
    const latencyMs = Math.round(performance.now() - started);
    await record('ai.request_failed', lastKind);
    log.error('ai request failed', { kind: lastKind, attempts, latencyMs });
    return failedResponse(requestId, lastKind, known.model, attempts, latencyMs);
  }

  return Object.freeze({
    async generate(tenant: TenantContext, request: AIRequest): Promise<AIResponse> {
      const requestId = requestIdOf(request);
      const organizationId = await organizationOf(tenant);
      if (organizationId === undefined) {
        return deniedResponse(
          requestId,
          isResolvedTenant(tenant) ? 'organization_inactive' : 'unresolved_tenant',
        );
      }
      const ctx = callContext(tenant, organizationId, requestId);
      const { deny } = ctx;

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
      ctx.known.target = { type: 'execution', id: execution.id };
      ctx.correlate({
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

      return callModel(ctx, request, policy);
    },

    async assist(tenant: TenantContext, request: AssistedAIRequest): Promise<AIResponse> {
      const requestId = requestIdOf(request);
      const organizationId = await organizationOf(tenant);
      if (organizationId === undefined) {
        return deniedResponse(
          requestId,
          isResolvedTenant(tenant) ? 'organization_inactive' : 'unresolved_tenant',
        );
      }
      const ctx = callContext(tenant, organizationId, requestId);
      const { deny } = ctx;

      // 1. Environment and the request itself.
      if (environment === undefined) return deny('environment_unknown');
      const problem = checkAssistedAIRequest(request);
      if (problem !== undefined) return deny(problem);
      ctx.known.target = { type: request.subject.type, id: request.subject.id };
      if (request.subject.type === 'conversation') {
        ctx.correlate({ conversationId: request.subject.id });
      }

      // 2. Authorization: only a person acting directly. GIA and the runtime act for a user but
      // are not that user asking; they get no assisted path of their own here.
      if (tenant.actor !== 'user') return deny('assist_requires_user');
      if (!authorization.authorize(tenant, ASSIST_PERMISSIONS[request.subject.type]).allowed) {
        return deny('permission_denied');
      }

      // 3. Policy: the subject's own named policy, never the default.
      const policy = policies.resolve(ASSIST_MODEL_POLICIES[request.subject.type]);
      if (policy === undefined) return deny('policy_not_found');

      return callModel(ctx, request, policy);
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
