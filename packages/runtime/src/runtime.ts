import type { AIRequest } from '@melonoffice/ai-gateway';
import type { Execution, ExecutionJob, ExecutionNode, JobId } from '@melonoffice/domain';
import {
  isExecutionError,
  isTerminal,
  retryRuleOf,
  UNKNOWN_OUTCOME_CODES,
} from '@melonoffice/execution';
import { isJobError, jobIdFor, type JobClaim, type JobService } from '@melonoffice/jobs';
import { withCorrelation, type Logger } from '@melonoffice/observability';
import type { TenantContext } from '@melonoffice/tenancy';
import { randomUUID } from 'node:crypto';
import { RuntimeError } from './errors.js';
import {
  RUNTIME_AI_FIELDS,
  type AgentWork,
  type JobDispatcher,
  type NodeWorkSource,
  type RuntimeServices,
  type VerificationSource,
} from './ports.js';

/**
 * How one `advance()` ended (ADR-0031). Codes are stable and safe to log.
 *
 * - `progressed`: the job's node ran or was already done; the next node's job, if any, is queued.
 * - `retrying`: the node failed and its one allowed retry is queued as a new job.
 * - `waiting_approval`: the node waits on a person; the job went back to the queue.
 * - `awaiting_resolution`: nobody knows whether the node's work happened. It is never re-run;
 *   a person resolves it.
 * - `verification_pending`: all work is done and no verifier gave evidence; it stays `verifying`.
 * - `completed` / `failed`: the execution ended.
 * - `execution_ended`: it had already ended (cancelled, for example); the job is cancelled.
 * - `duplicate`: another delivery of the same lease proof is working on it; nothing was done.
 */
export type AdvanceOutcome =
  | 'progressed'
  | 'retrying'
  | 'waiting_approval'
  | 'awaiting_resolution'
  | 'verification_pending'
  | 'completed'
  | 'failed'
  | 'execution_ended'
  | 'duplicate';

export interface AdvanceResult {
  readonly outcome: AdvanceOutcome;
  readonly code: string;
  /** The job queued next, when there is one. */
  readonly nextJobId?: JobId;
}

/**
 * The execution runtime (ADR-0031). It moves an execution forward one node at a time, from a job
 * a worker holds the lease of. It has no authority of its own: it acts as the runtime for the
 * user who started the execution, re-resolved from storage every time, and only through the
 * execution service, the tool gate, the AI gateway and the job service.
 */
export interface Runtime {
  /**
   * Runs the job's node, or finishes what an earlier delivery left, then queues the next node.
   * The request is exactly a lease proof `{ jobId, leaseId, revision }` from `acquire`: no
   * organization, user, role, tenant, approval, provider, model, node state or attempt.
   */
  advance(request: unknown): Promise<AdvanceResult>;
  /**
   * Queues the first node of an execution its owner just started, once. Refused once any node
   * moved (`execution_in_progress`): the runtime queues the rest itself, one node at a time.
   */
  kickoff(
    tenant: TenantContext,
    executionId: string,
    correlationId?: string,
  ): Promise<ExecutionJob>;
  /**
   * Hands a job back to a worker once a person decided the approval its node waits on. The
   * approval must be decided and be for exactly this execution, node and tool version; the
   * tool gate then checks it again against the exact input when the node runs.
   */
  resume(tenant: TenantContext, executionId: string, correlationId?: string): Promise<ExecutionJob>;
}

export interface RuntimeOptions {
  /** Leases, turns and finishes jobs; the only way the runtime gets a job and its context. */
  readonly jobs: Pick<JobService, 'turn' | 'release' | 'finish'>;
  /** The services for one correlation id: the id of the job being worked on. */
  readonly services: (correlationId: string) => RuntimeServices;
  readonly work?: NodeWorkSource;
  readonly verifier?: VerificationSource;
  readonly dispatcher?: JobDispatcher;
  readonly logger?: Logger;
}

const LEASE_PROOF_FIELDS = ['jobId', 'leaseId', 'revision'];

/** Exactly a lease proof. Any other field is refused, whatever it holds. */
function checkAdvanceRequest(value: unknown): {
  jobId: unknown;
  leaseId: unknown;
  revision: unknown;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuntimeError('invalid_request');
  }
  const keys = Object.keys(value);
  if (
    keys.length !== LEASE_PROOF_FIELDS.length ||
    !keys.every((k) => LEASE_PROOF_FIELDS.includes(k))
  ) {
    throw new RuntimeError('invalid_request', 'fields');
  }
  const { jobId, leaseId, revision } = value as Record<string, unknown>;
  return { jobId, leaseId, revision };
}

const isNodeDone = (node: ExecutionNode): boolean =>
  node.status === 'completed' || node.status === 'skipped';

const isUnknownOutcome = (node: ExecutionNode): boolean =>
  node.status === 'failed' &&
  node.error !== undefined &&
  UNKNOWN_OUTCOME_CODES.includes(node.error.code);

/** The first pending node, in graph order, whose dependencies are all done. */
function readyNode(execution: Execution): ExecutionNode | undefined {
  const done = new Set(execution.nodes.filter(isNodeDone).map((n) => n.id));
  return execution.nodes.find(
    (n) => n.status === 'pending' && n.dependsOn.every((d) => done.has(d)),
  );
}

export function createRuntime(options: RuntimeOptions): Runtime {
  const { jobs, services, work, verifier, dispatcher, logger } = options;

  const logOf = (job: ExecutionJob, leaseId?: string) =>
    logger === undefined
      ? undefined
      : withCorrelation(logger, {
          organizationId: job.organizationId,
          executionId: job.executionId,
          nodeId: job.nodeId,
          jobId: job.id,
          attempt: job.attempt,
          correlationId: job.correlationId,
          requestId: job.correlationId,
          ...(leaseId === undefined ? {} : { leaseId }),
        });

  async function dispatch(job: ExecutionJob): Promise<void> {
    if (dispatcher === undefined || job.state !== 'queued') return;
    try {
      await dispatcher.dispatch(job.id);
    } catch {
      // The job is stored and queued: a failed hand-off loses nothing (X6d delivers it again).
      logOf(job)?.warn('job dispatch failed');
    }
  }

  /** One job's work, from a claim this runtime took its turn with. */
  function work_(claim: JobClaim) {
    const { job, tenant } = claim;
    const s = services(job.correlationId);
    const log = logOf(job, claim.lease.leaseId);

    const finish = async (
      result: 'succeeded' | 'failed',
      code: string,
      outcome: AdvanceOutcome,
      nextJobId?: JobId,
    ): Promise<AdvanceResult> => {
      try {
        await jobs.finish(claim, { result, code });
      } catch (error) {
        // The node's state is stored with its own audit; a lost lease only means another
        // worker will find it done and finish the job. Never undo or repeat the work here.
        if (!isJobError(error)) throw error;
        log?.warn('job finish refused', { code: error.code });
      }
      log?.info('job advanced', { outcome, code });
      return Object.freeze({
        outcome,
        code,
        ...(nextJobId === undefined ? {} : { nextJobId }),
      });
    };

    const load = () => s.executions.get(tenant, job.executionId);

    /** The execution ended: cancel its jobs, this one included. */
    async function ended(execution: Execution): Promise<AdvanceResult> {
      await s.jobs.cancelForExecution(tenant, execution.id);
      log?.info('job advanced', { outcome: 'execution_ended', code: execution.status });
      return Object.freeze({ outcome: 'execution_ended', code: execution.status });
    }

    /** Fails the execution with a stable code. Unfinished nodes are cancelled with it. */
    async function fail(execution: Execution, code: string): Promise<AdvanceResult> {
      try {
        await s.executions.runtimeChangeStatus(tenant, execution.id, {
          from: execution.status,
          to: 'failed',
          failure: { code },
        });
      } catch (error) {
        if (!isExecutionError(error)) throw error;
        const fresh = await load();
        if (isTerminal(fresh.status)) return ended(fresh);
        throw error;
      }
      const result = await finish('failed', code, 'failed');
      await s.jobs.cancelForExecution(tenant, execution.id);
      return result;
    }

    /** A running node found at the start: whoever ran it is gone. Never re-run. */
    async function unknown(execution: Execution, node: ExecutionNode): Promise<AdvanceResult> {
      try {
        await s.executions.markOutcomeUnknown(tenant, execution.id, node.id);
      } catch (error) {
        if (!isExecutionError(error)) throw error;
        return step(await load(), false);
      }
      return finish('failed', 'outcome_unknown', 'awaiting_resolution');
    }

    /** A failed node: its one allowed retry, or the end of the execution. */
    async function failed(execution: Execution, node: ExecutionNode): Promise<AdvanceResult> {
      const code = node.error?.code ?? 'node_failed';
      if (isUnknownOutcome(node)) return finish('failed', 'outcome_unknown', 'awaiting_resolution');
      try {
        retryRuleOf(node);
      } catch (error) {
        if (!isExecutionError(error)) throw error;
        return fail(execution, code);
      }
      const retried = await s.executions.retryNode(tenant, execution.id, node.id);
      const next = await s.jobs.enqueue(tenant, { executionId: retried.id, nodeId: node.id });
      await dispatch(next);
      return finish('failed', code, 'retrying', next.id);
    }

    /** Verifies finished work, then completes or fails the execution. Never skipped. */
    async function verify(execution: Execution): Promise<AdvanceResult> {
      let current = execution;
      if (current.status === 'running') {
        current = await s.executions.runtimeChangeStatus(tenant, current.id, {
          from: 'running',
          to: 'verifying',
        });
      }
      let result;
      if (current.verification === undefined) {
        const evidence =
          verifier === undefined ? undefined : await verifier.verify(tenant, current);
        if (evidence === undefined) {
          return finish('succeeded', 'verification_pending', 'verification_pending');
        }
        current = await s.executions.recordVerification(tenant, current.id, evidence.verification);
        result = evidence.result;
      }
      if (current.verification?.result !== 'passed') {
        return fail(current, 'verification_failed');
      }
      await s.executions.runtimeChangeStatus(tenant, current.id, {
        from: 'verifying',
        to: 'completed',
        ...(result === undefined ? {} : { result }),
      });
      return finish('succeeded', 'execution_completed', 'completed');
    }

    /** After a node: queue the next ready one, or verify once every node is done. */
    async function progress(): Promise<AdvanceResult> {
      const execution = await load();
      if (isTerminal(execution.status)) return ended(execution);
      if (execution.nodes.every(isNodeDone)) return verify(execution);
      const ready = readyNode(execution);
      if (ready === undefined) {
        if (execution.nodes.some(isUnknownOutcome)) {
          return finish('succeeded', 'outcome_unknown', 'awaiting_resolution');
        }
        return fail(execution, 'graph_blocked');
      }
      // Queued before this job finishes: if this worker stops in between, a takeover finds
      // the node done and queues the same job again, which is stored once.
      const next = await s.jobs.enqueue(tenant, { executionId: execution.id, nodeId: ready.id });
      await dispatch(next);
      return finish('succeeded', 'node_completed', 'progressed', next.id);
    }

    async function runTool(execution: Execution, node: ExecutionNode): Promise<AdvanceResult> {
      const input = work === undefined ? undefined : await work.toolInput(tenant, execution, node);
      if (input === undefined) return fail(execution, 'input_unavailable');
      const result = await s.gate.invoke(tenant, {
        executionId: execution.id,
        nodeId: node.id,
        input,
      });
      switch (result.status) {
        case 'success':
          return progress();
        case 'failure':
        case 'timeout': {
          const fresh = await load();
          const stored = fresh.nodes.find((n) => n.id === node.id);
          if (isTerminal(fresh.status) || stored?.status !== 'failed') return step(fresh, false);
          return failed(fresh, stored);
        }
        case 'requires_approval':
          await jobs.release(claim, 'waiting_approval');
          log?.info('job advanced', { outcome: 'waiting_approval' });
          return Object.freeze({ outcome: 'waiting_approval', code: 'approval_required' });
        case 'denied': {
          const fresh = await load();
          if (isTerminal(fresh.status)) return ended(fresh);
          // Another holder moved the node first: look at it again, never run it twice.
          if (result.code === 'node_not_pending') return step(fresh, false);
          return fail(fresh, result.code);
        }
      }
    }

    async function runAgent(execution: Execution, node: ExecutionNode): Promise<AdvanceResult> {
      // The execution's own specialist: the gateway refuses any other (ADR-0027).
      const { specialistId } = execution;
      if (specialistId === undefined) return fail(execution, 'specialist_required');
      const given = work === undefined ? undefined : await work.agentWork(tenant, execution, node);
      if (given === undefined) return fail(execution, 'input_unavailable');
      if (
        typeof given !== 'object' ||
        given === null ||
        RUNTIME_AI_FIELDS.some((f) => f in given)
      ) {
        return fail(execution, 'invalid_work');
      }
      // One logical call per job: the same job always asks with the same id, so the gateway and
      // the credits it consumes treat a repeat as the same call.
      const requestId = `job-${job.id}`;
      const request: AIRequest = {
        ...(given as AgentWork),
        requestId,
        executionId: execution.id,
        nodeId: node.id,
        specialistId,
      };
      try {
        await s.executions.runtimeChangeNode(tenant, execution.id, {
          nodeId: node.id,
          from: 'pending',
          to: 'running',
        });
      } catch (error) {
        if (!isExecutionError(error)) throw error;
        return step(await load(), false);
      }
      let response;
      try {
        response = await s.ai.generate(tenant, request);
      } catch {
        // Nobody knows whether the model was called: never call it again for this node.
        return unknown(execution, node);
      }
      if (response.status === 'completed') {
        await s.executions.runtimeChangeNode(tenant, execution.id, {
          nodeId: node.id,
          from: 'running',
          to: 'completed',
          output: { type: 'ai_request', id: requestId },
        });
        return progress();
      }
      const moved = await s.executions.runtimeChangeNode(tenant, execution.id, {
        nodeId: node.id,
        from: 'running',
        to: 'failed',
        error: { code: response.code },
      });
      const stored = moved.nodes.find((n) => n.id === node.id);
      return stored === undefined ? step(moved, false) : failed(moved, stored);
    }

    /** A structural node: it only joins or splits the graph, so it has nothing to run. */
    async function runStructural(
      execution: Execution,
      node: ExecutionNode,
    ): Promise<AdvanceResult> {
      for (const [from, to] of [
        ['pending', 'running'],
        ['running', 'completed'],
      ] as const) {
        try {
          await s.executions.runtimeChangeNode(tenant, execution.id, { nodeId: node.id, from, to });
        } catch (error) {
          if (!isExecutionError(error)) throw error;
          return step(await load(), false);
        }
      }
      return progress();
    }

    /** Decides what the job's node needs, from the stored execution only. */
    async function step(execution: Execution, first: boolean): Promise<AdvanceResult> {
      if (isTerminal(execution.status)) return ended(execution);
      if (execution.mode === 'plan') return finish('failed', 'plan_execution', 'failed');
      if (execution.status === 'verifying') return verify(execution);
      if (execution.status !== 'running' && execution.status !== 'waiting_approval') {
        return finish('failed', 'execution_not_runnable', 'failed');
      }
      const node = execution.nodes.find((n) => n.id === job.nodeId);
      if (node === undefined) return finish('failed', 'node_not_found', 'failed');
      if ((node.attempt ?? 1) !== job.attempt)
        return finish('failed', 'job_attempt_mismatch', 'failed');
      switch (node.status) {
        case 'completed':
        case 'skipped':
          return progress();
        case 'failed':
          return failed(execution, node);
        case 'running':
          // Found running before this delivery ran it: another run was lost. After this
          // delivery's own attempt, a running node means someone else holds it now.
          return first ? unknown(execution, node) : finish('failed', 'node_running', 'duplicate');
        case 'cancelled':
          return finish('failed', 'node_cancelled', 'failed');
        case 'pending':
          if (!first) return finish('failed', 'node_not_pending', 'duplicate');
          switch (node.type) {
            case 'tool':
              return runTool(execution, node);
            case 'agent':
              return runAgent(execution, node);
            case 'parallel':
              return runStructural(execution, node);
            default:
              // condition, workflow, approval, verification, delay and event have no defined
              // behaviour yet: refused safely, never guessed (ADR-0031).
              return fail(execution, 'node_type_unsupported');
          }
      }
    }

    return { start: async () => step(await load(), true) };
  }

  /** The owner or the runtime only. GIA never starts or resumes work (ADR-0029). */
  function requirePersonOrRuntime(tenant: TenantContext): void {
    if (tenant.actor !== 'user' && tenant.actor !== 'runtime') {
      throw new RuntimeError('actor_not_allowed', `${tenant.actor}_cannot_drive_runtime`);
    }
  }

  const runtime: Runtime = {
    async advance(request) {
      const proof = checkAdvanceRequest(request);
      let claim: JobClaim;
      try {
        claim = await jobs.turn(proof);
      } catch (error) {
        if (isJobError(error)) {
          if (error.code === 'job_revision_mismatch' || error.code === 'job_terminal') {
            return Object.freeze({ outcome: 'duplicate', code: error.code });
          }
          if (error.code === 'job_cancelled') {
            return Object.freeze({ outcome: 'execution_ended', code: error.code });
          }
        }
        throw error;
      }
      return work_(claim).start();
    },

    async kickoff(tenant, executionId, correlationId) {
      requirePersonOrRuntime(tenant);
      const s = services(correlationOf(correlationId));
      const execution = await s.executions.get(tenant, executionId);
      if (execution.nodes.some((n) => n.status !== 'pending')) {
        throw new RuntimeError('execution_in_progress');
      }
      const ready = readyNode(execution);
      if (ready === undefined) throw new RuntimeError('nothing_to_run');
      const job = await s.jobs.enqueue(tenant, { executionId: execution.id, nodeId: ready.id });
      await dispatch(job);
      return job;
    },

    async resume(tenant, executionId, correlationId) {
      requirePersonOrRuntime(tenant);
      const s = services(correlationOf(correlationId));
      const execution = await s.executions.get(tenant, executionId);
      if (execution.status !== 'waiting_approval') throw new RuntimeError('execution_not_waiting');
      const waiting = execution.nodes.filter(
        (n) => n.status === 'pending' && n.type === 'tool' && n.approvalId !== undefined,
      );
      const node = waiting.length === 1 ? waiting[0] : undefined;
      if (node?.approvalId === undefined || node.tool === undefined) {
        throw new RuntimeError('execution_not_waiting', 'node');
      }
      const approval = await s.approvals.get(tenant, node.approvalId);
      if (approval.status === 'pending') throw new RuntimeError('approval_pending');
      const { operation } = approval;
      if (
        approval.organizationId !== execution.organizationId ||
        operation.executionId !== execution.id ||
        operation.nodeId !== node.id ||
        operation.toolId !== node.tool.id ||
        operation.toolVersion !== node.tool.version
      ) {
        throw new RuntimeError('approval_mismatch');
      }
      const job = await s.jobs.get(
        tenant,
        jobIdFor(execution.organizationId, execution.id, node.id, node.attempt ?? 1),
      );
      if (job.state !== 'queued') throw new RuntimeError('job_not_resumable', job.state);
      await dispatch(job);
      return job;
    },
  };
  return Object.freeze(runtime);
}

const CORRELATION_ID = /^[\w-]{1,128}$/;
/** The caller's request id, to correlate with; a new one when it has none or a malformed one. */
const correlationOf = (value: string | undefined): string =>
  value !== undefined && CORRELATION_ID.test(value) ? value : randomUUID();
