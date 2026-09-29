import {
  checkApprovalUse,
  isApprovalError,
  type ApprovalService,
  type ApprovalUseProblem,
} from '@melonoffice/approvals';
import {
  actorOf,
  buildAuditEvent,
  type AuditAction,
  type AuditEvent,
  type AuditResult,
  type AuditService,
} from '@melonoffice/audit';
import { isDepartmentId, type DepartmentRepository } from '@melonoffice/departments';
import type {
  Approval,
  ApprovalId,
  ApprovalOperation,
  Department,
  DeploymentEnvironment,
  Execution,
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
  SpecialistVersion,
} from '@melonoffice/domain';
import {
  applyNodeChange,
  applyStatusChange,
  attachApproval,
  recordVerification,
  isExecutionError,
  isExecutionId,
  type ExecutionRepository,
} from '@melonoffice/execution';
import { withCorrelation, type Logger } from '@melonoffice/observability';
import type { AuthorizationService } from '@melonoffice/rbac';
import {
  createSkillCatalogue,
  grantsOf,
  type EligibilityDecision,
  type SkillCatalogue,
  type SpecialistService,
} from '@melonoffice/specialists';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import {
  digestOf,
  idempotencyKeyOf,
  isHumanInvocable,
  type ToolExecutionContext,
  type ToolExecutorOutcome,
  type ToolExecutors,
  type ToolRegistry,
  type ToolResult,
} from '@melonoffice/tools';
import {
  DEFAULT_RISK_POLICY,
  evaluatePostExecution,
  evaluateHumanPreExecution,
  evaluatePreExecution,
  nodeOf,
  type RiskPolicy,
} from './rules.js';

/**
 * What a server-side caller asks: run the tool of one node of one execution with this input.
 * There is no organization, user, approval or tool here: they come from the tenant and the
 * stored execution, never from the caller, the input or a model.
 */
export interface ToolInvocation {
  readonly executionId: string;
  readonly nodeId: string;
  readonly input: unknown;
}

/**
 * The only way a tool runs (ADR-0026):
 *
 *   Execution → Authorization → Guardrails → Approval → Tool → Result → (future) Verification.
 *
 * There is no client route to it: planners, workflows and GIA call it on the server, with the
 * tenant of the user the work is for. GIA goes through exactly the same checks.
 *
 * Two callers reach it (ADR-0034). The runtime, for a specialist's execution (ADR-0031), with
 * every check that path always had. And a person acting directly, synchronously, for a tool
 * whose version says `human` explicitly, in an execution of their own with no specialist: the
 * human guardrails, no approval, and the execution finished in the same write as the node, since
 * no runtime will come back to it. Anyone else, and any other tool, is refused `runtime_only`.
 */
export interface ToolGate {
  invoke(tenant: TenantContext, invocation: ToolInvocation): Promise<ToolResult>;
}

export interface ToolGateOptions {
  readonly executions: ExecutionRepository;
  /** Only `findOrganization` is used, to refuse inactive organizations. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly specialists: Pick<SpecialistService, 'eligibility' | 'getVersion'>;
  readonly departments: DepartmentRepository;
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalService;
  readonly executors: ToolExecutors;
  readonly authorization: Pick<AuthorizationService, 'permissionsOf'>;
  /** Records decisions that change nothing stored, such as denials. */
  readonly audit: AuditService;
  /** Where this server runs, set explicitly. Undefined: no tool runs anywhere (fail closed). */
  readonly environment: DeploymentEnvironment | undefined;
  readonly riskPolicy?: RiskPolicy;
  /**
   * The skill catalogue a specialist version's skills are read from (ADR-0069/0083). Absent: the
   * catalogue in code. Tests give their own.
   */
  readonly skills?: SkillCatalogue;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly requestId?: string;
  /** Waits between retries. Tests replace it. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const CODE = /^[a-z][a-z_]{0,63}$/;
/** A provider's failure code as recorded: a stable code, or a generic one. Never its message. */
const codeOf = (code: string): string => (CODE.test(code) ? code : 'tool_failure');

const denied = (code: string): ToolResult => Object.freeze({ status: 'denied', code });

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
};

type Timed = ToolExecutorOutcome | { readonly status: 'timeout' };

function withDeadline(work: Promise<ToolExecutorOutcome>, ms: number): Promise<Timed> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Timed>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), Math.max(0, ms));
  });
  // An executor that throws reports a failure: the gate never passes on its error.
  const outcome = work.catch((): Timed => ({ status: 'failure', code: 'executor_error' }));
  return Promise.race([outcome, timeout]).finally(() => clearTimeout(timer));
}

export function createToolGate(options: ToolGateOptions): ToolGate {
  const {
    executions,
    organizations,
    specialists,
    departments,
    registry,
    approvals,
    executors,
    authorization,
    audit,
    environment,
    riskPolicy = DEFAULT_RISK_POLICY,
    skills = createSkillCatalogue(),
    now = () => new Date(),
    requestId,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;

  const eventOf = (
    tenant: TenantContext,
    organizationId: OrganizationId,
    fields: {
      readonly action: AuditAction;
      readonly result: AuditResult;
      readonly executionId?: string;
      readonly tool?: { readonly id: string; readonly version: number };
      readonly reason?: string;
      readonly transition?: { readonly from: string; readonly to: string };
      readonly nodeId?: string;
    },
    at: Date,
  ): AuditEvent =>
    buildAuditEvent(
      {
        action: fields.action,
        result: fields.result,
        actor: actorOf(tenant),
        organizationId,
        ...(fields.executionId === undefined
          ? {}
          : { target: { type: 'execution' as const, id: fields.executionId } }),
        ...(fields.tool === undefined ? {} : { tool: fields.tool }),
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
        ...(fields.transition === undefined ? {} : { transition: fields.transition }),
        ...(fields.nodeId === undefined ? {} : { nodeId: fields.nodeId }),
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  async function organizationOf(tenant: TenantContext): Promise<OrganizationId | undefined> {
    if (!isResolvedTenant(tenant)) return undefined;
    const organization = await organizations.findOrganization(tenant.organizationId);
    return organization?.id === tenant.organizationId && organization.status === 'active'
      ? organization.id
      : undefined;
  }

  async function specialistFacts(
    tenant: TenantContext,
    organizationId: OrganizationId,
    execution: Execution | undefined,
  ): Promise<{
    eligibility?: EligibilityDecision;
    version?: SpecialistVersion;
    department?: Department;
  }> {
    const { specialistId, specialistVersion, departmentId } = execution ?? {};
    if (specialistId === undefined || specialistVersion === undefined) return {};
    if (departmentId === undefined) return {};
    // Checked again now, not only when the execution was created: a specialist paused or
    // changed since then no longer runs anything.
    const eligibility = await specialists.eligibility(tenant, {
      specialistId,
      departmentId,
      version: specialistVersion,
    });
    if (!eligibility.eligible) return { eligibility };
    const version = await specialists.getVersion(tenant, specialistId, specialistVersion);
    const department = isDepartmentId(departmentId)
      ? await departments.find(organizationId, departmentId)
      : undefined;
    return {
      eligibility,
      version,
      ...(department === undefined ? {} : { department }),
    };
  }

  /**
   * Whether this is a person's own call to a tool built for it (ADR-0034): a user acting directly
   * (never GIA, never the runtime), on a node whose exact tool version says `human`. Reads only.
   */
  async function isHumanCall(
    tenant: TenantContext,
    organizationId: OrganizationId,
    invocation: ToolInvocation,
  ): Promise<boolean> {
    if (tenant.actor !== 'user' || !isExecutionId(invocation.executionId)) return false;
    const execution = await executions.find(organizationId, invocation.executionId);
    const ref = nodeOf(execution, invocation.nodeId)?.tool;
    const tool = ref === undefined ? undefined : registry.resolve(ref.id, ref.version);
    return tool !== undefined && isHumanInvocable(tool.version);
  }

  return Object.freeze({
    async invoke(tenant: TenantContext, invocation: ToolInvocation): Promise<ToolResult> {
      const organizationId = await organizationOf(tenant);
      if (organizationId === undefined) {
        return denied(isResolvedTenant(tenant) ? 'organization_inactive' : 'unresolved_tenant');
      }
      // Tools run inside executions, and executions are driven by the runtime (ADR-0031): a
      // person or GIA reaches a tool through a plan or an execution, never by calling the gate.
      // The one addition (ADR-0034): a person's own call to a tool that says `human`.
      const human =
        tenant.actor !== 'runtime' && (await isHumanCall(tenant, organizationId, invocation));
      if (tenant.actor !== 'runtime' && !human) {
        await audit.record(
          eventOf(
            tenant,
            organizationId,
            {
              action: 'tool.execution_denied',
              result: 'denied',
              ...(isExecutionId(invocation.executionId)
                ? { executionId: invocation.executionId }
                : {}),
              reason: 'runtime_only',
            },
            now(),
          ),
        );
        return denied('runtime_only');
      }
      const { nodeId, input } = invocation;
      const execution = isExecutionId(invocation.executionId)
        ? await executions.find(organizationId, invocation.executionId)
        : undefined;
      const node = nodeOf(execution, nodeId);
      const ref = node?.tool;
      const tool = ref === undefined ? undefined : registry.resolve(ref.id, ref.version);
      const facts = human ? {} : await specialistFacts(tenant, organizationId, execution);
      const log = withCorrelation(options.logger ?? silent, {
        ...(requestId === undefined ? {} : { requestId }),
        organizationId,
        ...(execution === undefined ? {} : { executionId: execution.id }),
        nodeId,
        ...(execution?.specialistId === undefined ? {} : { specialistId: execution.specialistId }),
        ...(ref === undefined ? {} : { toolId: ref.id, toolVersion: ref.version }),
      });

      const decision = human
        ? evaluateHumanPreExecution({
            execution,
            nodeId,
            userId: tenant.userId,
            tool,
            permissions: authorization.permissionsOf(tenant),
            environment,
            executors,
            riskPolicy,
            input,
          })
        : evaluatePreExecution({
            execution,
            nodeId,
            eligibility: facts.eligibility,
            specialistVersion: facts.version,
            department: facts.department,
            tool,
            permissions: authorization.permissionsOf(tenant),
            environment,
            executors,
            riskPolicy,
            input,
            granted:
              facts.version === undefined
                ? new Set<string>()
                : grantsOf(facts.version.configuration.skills, skills).tools,
          });

      const deny = async (reason: string): Promise<ToolResult> => {
        const at = now();
        const common = {
          ...(execution === undefined ? {} : { executionId: execution.id }),
          ...(ref === undefined ? {} : { tool: { id: ref.id, version: ref.version } }),
          reason,
        };
        await audit.record(
          eventOf(
            tenant,
            organizationId,
            { action: 'tool.authorization_checked', result: 'denied', ...common },
            at,
          ),
        );
        await audit.record(
          eventOf(
            tenant,
            organizationId,
            { action: 'tool.execution_denied', result: 'denied', ...common },
            at,
          ),
        );
        log.info('tool denied', { reason });
        return denied(reason);
      };

      if (decision.decision === 'deny') return deny(decision.reason);
      // The checks above guarantee all of these; the narrowing is for the compiler.
      if (
        execution === undefined ||
        node === undefined ||
        ref === undefined ||
        tool === undefined
      ) {
        return deny('execution_not_found');
      }
      const executionId: ExecutionId = execution.id;
      const toolRef = { id: ref.id, version: ref.version };

      let approvalId: ApprovalId | undefined;
      // A person's call has no approval: its guardrails allowed only `auto` (ADR-0034).
      if (!human) {
        if (execution.specialistId === undefined || execution.specialistVersion === undefined) {
          return deny('execution_not_found');
        }
        // The exact operation, rebuilt from verified context. An approval covers this and nothing else.
        const operation: ApprovalOperation = {
          organizationId,
          executionId,
          nodeId: node.id,
          specialistId: execution.specialistId,
          specialistVersion: execution.specialistVersion,
          toolId: ref.id,
          toolVersion: ref.version,
          action: tool.version.action,
          inputDigest: digestOf(input),
        };

        if (node.approvalId !== undefined) {
          // An attached approval must cover this call, whatever the policy says now.
          let approval: Approval | undefined;
          try {
            approval = await approvals.get(tenant, node.approvalId);
          } catch (error) {
            if (!isApprovalError(error)) throw error;
          }
          const problem: ApprovalUseProblem | undefined =
            approval === undefined
              ? 'approval_mismatch'
              : checkApprovalUse(approval, operation, now());
          if (problem === 'approval_pending') {
            return Object.freeze({ status: 'requires_approval', approvalId: node.approvalId });
          }
          if (problem === 'approval_expired' && approval?.status === 'pending') {
            try {
              await approvals.expire(tenant, approval.id);
            } catch (error) {
              // Decided concurrently: the refusal below stands either way.
              if (!isApprovalError(error)) throw error;
            }
          }
          if (problem !== undefined) return deny(problem);
          approvalId = node.approvalId;
        } else if (decision.decision === 'require_approval') {
          const approval = await approvals.request(tenant, {
            operation,
            riskLevel: tool.version.riskLevel,
            reason: 'approval_required',
            impact: tool.version.mutating ? 'changes_data' : 'reads_data',
            ttlSeconds: tool.version.approvalTtlSeconds,
          });
          const at = now();
          const iso = at.toISOString() as IsoTimestamp;
          try {
            await executions.update(organizationId, executionId, (current) => {
              let next = attachApproval(current, nodeId, approval.id, iso);
              const events = [
                eventOf(
                  tenant,
                  organizationId,
                  {
                    action: 'tool.authorization_checked',
                    result: 'success',
                    executionId,
                    tool: toolRef,
                    reason: 'approval_required',
                  },
                  at,
                ),
              ];
              if (current.status === 'running') {
                next = applyStatusChange(
                  next,
                  { from: 'running', to: 'waiting_approval' },
                  tenant.userId,
                  iso,
                );
                events.push(
                  eventOf(
                    tenant,
                    organizationId,
                    {
                      action: 'execution.state_changed',
                      result: 'success',
                      executionId,
                      transition: { from: 'running', to: 'waiting_approval' },
                    },
                    at,
                  ),
                );
              }
              return { execution: { ...next, revision: current.revision + 1 }, events };
            });
          } catch (error) {
            // Another call attached first, or the execution ended: withdraw this approval.
            await approvals.cancel(tenant, approval.id, 'not_attached').catch(() => undefined);
            if (isExecutionError(error)) return deny('node_not_pending');
            throw error;
          }
          log.info('tool requires approval');
          return Object.freeze({ status: 'requires_approval', approvalId: approval.id });
        }
      }

      // Start: only one caller moves the node from pending to running (idempotency).
      const startAt = now();
      const startIso = startAt.toISOString() as IsoTimestamp;
      try {
        await executions.update(organizationId, executionId, (current) => {
          let next = current;
          const events: AuditEvent[] = [];
          if (current.status === 'waiting_approval') {
            next = applyStatusChange(
              next,
              { from: 'waiting_approval', to: 'running' },
              tenant.userId,
              startIso,
            );
            events.push(
              eventOf(
                tenant,
                organizationId,
                {
                  action: 'execution.state_changed',
                  result: 'success',
                  executionId,
                  transition: { from: 'waiting_approval', to: 'running' },
                },
                startAt,
              ),
            );
          }
          // The key is recorded before the effect, so a retry of this node repeats it (ADR-0029).
          next = applyNodeChange(
            next,
            {
              nodeId,
              from: 'pending',
              to: 'running',
              ...(tool.version.mutating
                ? { idempotencyKey: idempotencyKeyOf(executionId, nodeId, ref.id, ref.version) }
                : {}),
            },
            startIso,
          );
          events.push(
            eventOf(
              tenant,
              organizationId,
              {
                action: 'execution.node_changed',
                result: 'success',
                executionId,
                nodeId,
                transition: { from: 'pending', to: 'running' },
              },
              startAt,
            ),
            eventOf(
              tenant,
              organizationId,
              {
                action: 'tool.authorization_checked',
                result: 'success',
                executionId,
                tool: toolRef,
                reason: approvalId === undefined ? 'allowed' : 'approved',
              },
              startAt,
            ),
            eventOf(
              tenant,
              organizationId,
              { action: 'tool.execution_requested', result: 'success', executionId, tool: toolRef },
              startAt,
            ),
          );
          return { execution: { ...next, revision: current.revision + 1 }, events };
        });
      } catch (error) {
        if (isExecutionError(error)) return deny('node_not_pending');
        throw error;
      }

      const deadline = new Date(startAt.getTime() + tool.version.timeoutMs);
      const viaOf = (t: TenantContext): ToolExecutionContext['actor']['via'] =>
        t.actor === 'runtime' ? 'runtime' : t.actor === 'gia' ? 'gia' : 'direct';
      const context: ToolExecutionContext = Object.freeze({
        organizationId,
        executionId,
        nodeId: node.id,
        ...(execution.specialistId === undefined || execution.specialistVersion === undefined
          ? {}
          : {
              specialistId: execution.specialistId,
              specialistVersion: execution.specialistVersion,
            }),
        toolId: ref.id,
        toolVersion: ref.version,
        action: tool.version.action,
        actor: {
          userId: tenant.userId,
          via: viaOf(tenant),
        },
        riskLevel: tool.version.riskLevel,
        ...(approvalId === undefined ? {} : { approvalId }),
        ...(tool.version.mutating
          ? { idempotencyKey: idempotencyKeyOf(executionId, nodeId, ref.id, ref.version) }
          : {}),
        environment: environment as DeploymentEnvironment,
        ...(requestId === undefined ? {} : { requestId }),
        deadline,
      });
      // A frozen copy: the executor can neither change the caller's input nor keep a live link.
      const frozenInput = deepFreeze(structuredClone(input));
      const executor = executors[tool.version.provider.id];
      const started = performance.now();
      let outcome: Timed = { status: 'failure', code: 'executor_unavailable' };
      if (executor !== undefined) {
        const { maxAttempts, backoffMs } = tool.version.retryPolicy;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const remaining = deadline.getTime() - startAt.getTime() - (performance.now() - started);
          outcome = await withDeadline(executor.execute(context, frozenInput), remaining);
          // A timeout is not retried: whether the tool acted is unknown.
          if (outcome.status !== 'failure' || attempt === maxAttempts) break;
          await sleep(backoffMs);
        }
      }
      const durationMs = Math.round(performance.now() - started);

      let result: ToolResult;
      let failure: string | undefined;
      if (outcome.status === 'timeout') {
        failure = 'timeout';
        result = Object.freeze({ status: 'timeout', durationMs });
      } else if (outcome.status === 'failure') {
        failure = codeOf(outcome.code);
        result = Object.freeze({ status: 'failure', code: failure, durationMs });
      } else {
        const problem = evaluatePostExecution(tool, outcome.output);
        if (problem !== undefined) {
          failure = problem;
          result = Object.freeze({ status: 'failure', code: problem, durationMs });
        } else {
          result = Object.freeze({
            status: 'success',
            output: outcome.output,
            ...(outcome.outputRef === undefined ? {} : { outputRef: outcome.outputRef }),
            durationMs,
          });
        }
      }

      // Finish the node. A failure never completes the execution; on the runtime's path nothing
      // here completes it. A person's call is finished here too (ADR-0034), since no runtime will
      // come back to it: its one node's output is verified against the schema just checked.
      const endAt = now();
      const endIso = endAt.toISOString() as IsoTimestamp;
      try {
        await executions.update(organizationId, executionId, (current) => {
          const finished = applyNodeChange(
            current,
            failure === undefined
              ? {
                  nodeId,
                  from: 'running',
                  to: 'completed',
                  ...(result.status === 'success' && result.outputRef !== undefined
                    ? { output: result.outputRef }
                    : {}),
                }
              : { nodeId, from: 'running', to: 'failed', error: { code: failure } },
            endIso,
          );
          const events: AuditEvent[] = [
            eventOf(
              tenant,
              organizationId,
              {
                action: 'execution.node_changed',
                result: 'success',
                executionId,
                nodeId,
                transition: { from: 'running', to: failure === undefined ? 'completed' : 'failed' },
                ...(failure === undefined ? {} : { reason: failure }),
              },
              endAt,
            ),
            eventOf(
              tenant,
              organizationId,
              failure === undefined
                ? {
                    action: 'tool.execution_completed',
                    result: 'success',
                    executionId,
                    tool: toolRef,
                  }
                : {
                    action: 'tool.execution_failed',
                    result: 'failure',
                    executionId,
                    tool: toolRef,
                    reason: failure,
                  },
              endAt,
            ),
          ];
          if (!human) return { execution: finished, events };
          const ended = finishHumanExecution(finished, failure, tenant.userId, endIso);
          for (const [index, transition] of ended.transitions.entries()) {
            if (index === 1) {
              events.push(
                eventOf(
                  tenant,
                  organizationId,
                  {
                    action: 'execution.verification_recorded',
                    result: 'success',
                    executionId,
                    reason: 'verification_passed',
                  },
                  endAt,
                ),
              );
            }
            events.push(
              eventOf(
                tenant,
                organizationId,
                {
                  action: 'execution.state_changed',
                  result: 'success',
                  executionId,
                  transition,
                },
                endAt,
              ),
            );
          }
          return { execution: { ...ended.execution, revision: current.revision + 1 }, events };
        });
      } catch (error) {
        if (!isExecutionError(error)) throw error;
        // The execution ended (e.g. was cancelled) while the tool ran: its output is not passed on.
        log.warn('tool finished after its execution ended', { code: error.code });
        return Object.freeze({ status: 'failure', code: 'execution_ended', durationMs });
      }
      log.info('tool finished', { status: result.status, durationMs });
      return result;
    },
  });
}

/**
 * Ends a person's one-node execution with its node (ADR-0034), with the model's own rules: a
 * failed node fails it; a completed one is verified against the output schema the gate has just
 * checked, recorded as evidence, and only then completes it. There is no shortcut.
 */
function finishHumanExecution(
  execution: Execution,
  failure: string | undefined,
  by: TenantContext['userId'],
  iso: IsoTimestamp,
): {
  readonly execution: Execution;
  readonly transitions: readonly { readonly from: string; readonly to: string }[];
} {
  if (failure !== undefined) {
    return {
      execution: applyStatusChange(
        execution,
        { from: 'running', to: 'failed', failure: { code: failure } },
        by,
        iso,
      ),
      transitions: [{ from: 'running', to: 'failed' }],
    };
  }
  // Another node still to run: the execution goes on, and a later call of the person ends it.
  const finished = (status: string) => status === 'completed' || status === 'skipped';
  if (!execution.nodes.every((n) => finished(n.status))) {
    return { execution, transitions: [] };
  }
  const verifying = applyStatusChange(execution, { from: 'running', to: 'verifying' }, by, iso);
  // Every completed node ran through this gate, whose output schema check it passed.
  const verified = recordVerification(
    verifying,
    {
      correlationId: `human-${execution.id}`,
      nodes: execution.nodes
        .filter((n) => n.status === 'completed')
        .map((n) => ({
          nodeId: n.id,
          policy: 'output_schema',
          checks: [
            {
              code: 'output_schema_valid',
              result: 'passed',
              evidence: { type: 'tool_output', id: n.id },
            },
          ],
        })),
    },
    iso,
  );
  return {
    execution: applyStatusChange(verified, { from: 'verifying', to: 'completed' }, by, iso),
    transitions: [
      { from: 'running', to: 'verifying' },
      { from: 'verifying', to: 'completed' },
    ],
  };
}

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};
