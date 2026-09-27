import {
  actorOf,
  type AuditActor,
  type AuditEvent,
  type AuditEventInput,
  buildAuditEvent,
} from '@melonoffice/audit';
import type {
  Execution,
  ExecutionJob,
  IsoTimestamp,
  JobId,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import {
  isExecutionId,
  isTerminal,
  MAX_NODE_ATTEMPTS,
  type ExecutionRepository,
} from '@melonoffice/execution';
import { withCorrelation, type Logger } from '@melonoffice/observability';
import {
  isResolvedTenant,
  resolveRuntimeTenant,
  type TenancyStore,
  type TenantContext,
} from '@melonoffice/tenancy';
import { randomUUID } from 'node:crypto';
import { isJobError, JobError } from './errors.js';
import {
  acquireLease,
  cancelJob,
  checkFinish,
  finishJob,
  isCorrelationId,
  isJobId,
  isJobTerminal,
  isWorkerId,
  jobIdFor,
  newJob,
  type LeaseProof,
} from './model.js';
import type { JobRepository } from './repository.js';

/**
 * What a worker holds after taking a job's lease: the job as leased, the proof it writes with,
 * and the runtime context of the user who started the execution, resolved again from the stored
 * execution. Nothing in it comes from the worker.
 */
export interface JobClaim {
  readonly job: ExecutionJob;
  readonly lease: LeaseProof;
  readonly tenant: TenantContext;
}

/**
 * Execution jobs (ADR-0030): the pointers the runtime will work from. This service creates,
 * leases, finishes and cancels them. It runs nothing: it never advances an execution, calls a
 * model or runs a tool. Those will use a claim and the execution service, in later phases.
 */
export interface JobService {
  /**
   * Creates the job for one node of an execution of the tenant's organization, at the node's
   * current attempt, once. The request names only `executionId` and `nodeId`: the organization
   * comes from the tenant and the stored execution, the attempt from the stored node. A second
   * call for the same node and attempt returns the job already created and writes nothing.
   */
  enqueue(tenant: TenantContext, request: unknown): Promise<ExecutionJob>;
  /** `job_not_found` for an unknown id and for another organization's job alike. */
  get(tenant: TenantContext, id: string): Promise<ExecutionJob>;
  /**
   * A worker takes a job's lease. The worker gives only the job id and its own instance id: the
   * organization, the user and the attempt are read from the stored job and execution, and the
   * user's membership is checked again. One live lease at a time; a job whose execution ended is
   * cancelled instead.
   */
  acquire(jobId: string, workerId: string): Promise<JobClaim>;
  /** The lease holder records how the job ended, while its lease is current and live. */
  finish(claim: JobClaim, outcome: unknown): Promise<ExecutionJob>;
  /**
   * Cancels every unfinished job of an execution that ended, so no worker can take or finish one.
   * Refused while the execution is still running (`execution_not_ended`). Idempotent.
   */
  cancelForExecution(tenant: TenantContext, executionId: string): Promise<readonly ExecutionJob[]>;
}

/** The part of RBAC this service asks (ADR-0019). No new permission: jobs follow the execution's. */
export interface JobAuthorization {
  authorize(
    tenant: TenantContext,
    permission: 'execution.start' | 'execution.cancel',
    resource: { readonly organizationId: OrganizationId },
  ): { readonly allowed: boolean; readonly reason?: string };
}

/** Where refusals are recorded. Successful changes are written with the job instead. */
export interface JobAuditLog {
  record(input: AuditEventInput): Promise<unknown>;
}

export interface JobServiceOptions {
  readonly jobs: JobRepository;
  /** Only `find` is used: jobs read executions, never change them. */
  readonly executions: Pick<ExecutionRepository, 'find'>;
  readonly tenancy: TenancyStore;
  readonly authorization: JobAuthorization;
  readonly audit: JobAuditLog;
  /**
   * How long a lease lasts, in milliseconds. Required: its value belongs to the worker's
   * deployment (X6d), so none is assumed here.
   */
  readonly leaseMs: number;
  /** The server's clock. Every lease time comes from it, never from a caller. */
  readonly now?: () => Date;
  /** New lease ids. Random by default. */
  readonly newLeaseId?: () => string;
  /** The request that asked, to correlate a new job with it. A random id otherwise. */
  readonly requestId?: string;
  readonly logger?: Logger;
}

const ENDED = 'execution_ended';

export function createJobService({
  jobs,
  executions,
  tenancy,
  authorization,
  audit,
  leaseMs,
  now = () => new Date(),
  newLeaseId = randomUUID,
  requestId,
  logger,
}: JobServiceOptions): JobService {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new JobError('invalid_job', 'leaseMs');

  const log = (job: ExecutionJob, fields: { leaseId?: string; workerId?: string } = {}) =>
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
          ...fields,
        });

  const jobEvent = (
    fields: Pick<AuditEventInput, 'action' | 'result' | 'actor' | 'reason'>,
    job: ExecutionJob,
    leaseId: string | undefined,
    at: Date,
  ): AuditEvent => buildAuditEvent(eventInput(fields, job, leaseId), at);

  const eventInput = (
    fields: Pick<AuditEventInput, 'action' | 'result' | 'actor' | 'reason'>,
    job: ExecutionJob,
    leaseId: string | undefined,
  ): AuditEventInput => ({
    ...fields,
    organizationId: job.organizationId,
    target: { type: 'execution', id: job.executionId },
    job: {
      id: job.id,
      nodeId: job.nodeId,
      attempt: job.attempt,
      ...(leaseId === undefined ? {} : { leaseId }),
    },
    requestId: job.correlationId,
    source: 'api',
  });

  const iso = (at: Date) => at.toISOString() as IsoTimestamp;

  async function organizationOf(tenant: TenantContext): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new JobError('unresolved_tenant');
    const organization = await tenancy.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new JobError('organization_inactive');
    }
    return organization.id;
  }

  /** A user acting directly, or the runtime for one, holding the permission. Never GIA. */
  function authorize(
    tenant: TenantContext,
    organizationId: OrganizationId,
    permission: 'execution.start' | 'execution.cancel',
  ): void {
    if (tenant.actor !== 'user' && tenant.actor !== 'runtime') {
      throw new JobError('actor_not_allowed', `${tenant.actor}_cannot_manage_jobs`);
    }
    const decision = authorization.authorize(tenant, permission, { organizationId });
    if (!decision.allowed) throw new JobError('permission_denied', decision.reason);
  }

  /** The stored job, only when it is of this organization; otherwise exactly like an absent one. */
  async function jobIn(organizationId: OrganizationId, id: string): Promise<ExecutionJob> {
    if (!isJobId(id)) throw new JobError('job_not_found');
    const job = await jobs.find(id);
    if (job === undefined || job.organizationId !== organizationId) {
      throw new JobError('job_not_found');
    }
    return job;
  }

  /** The job's execution, read with the job's own organization. */
  async function executionOf(job: ExecutionJob): Promise<Execution | undefined> {
    const execution = await executions.find(job.organizationId, job.executionId);
    return execution?.organizationId === job.organizationId ? execution : undefined;
  }

  /** Cancels a job whose execution ended, unless it already ended. Returns the job as stored. */
  async function cancelEnded(
    job: ExecutionJob,
    actor: AuditActor,
  ): Promise<ExecutionJob | undefined> {
    const at = now();
    try {
      const cancelled = await jobs.update(job.id, (current) => {
        const next = cancelJob(current, ENDED, iso(at));
        return {
          job: next,
          events: [
            jobEvent(
              { action: 'execution.job_cancelled', result: 'success', actor, reason: ENDED },
              next,
              current.lease?.leaseId,
              at,
            ),
          ],
        };
      });
      log(cancelled)?.info('job cancelled', { reason: ENDED });
      return cancelled;
    } catch (error) {
      if (isJobError(error) && (error.code === 'job_cancelled' || error.code === 'job_terminal')) {
        return undefined;
      }
      throw error;
    }
  }

  const runtimeActor = (userId: UserId): AuditActor => actorOf({ actor: 'runtime', userId });

  /** Records a refused worker write, then refuses it. Never records anything the worker sent. */
  async function deny(
    action: 'execution.job_leased' | 'execution.job_finished',
    job: ExecutionJob,
    initiatedBy: UserId | undefined,
    error: JobError,
    fields: { leaseId?: string; workerId?: string } = {},
  ): Promise<never> {
    log(job, fields)?.warn('job write refused', { code: error.code });
    if (initiatedBy !== undefined) {
      await audit.record(
        eventInput(
          {
            action,
            result: 'denied',
            actor: runtimeActor(initiatedBy),
            reason: error.code,
          },
          job,
          fields.leaseId,
        ),
      );
    }
    throw error;
  }

  /**
   * The runtime context of the execution's user, resolved again from stored data only. A user
   * who left, a suspended membership or an inactive organization gives none.
   */
  async function runtimeTenantOf(execution: Execution): Promise<TenantContext | undefined> {
    try {
      return await resolveRuntimeTenant(execution.userId, execution.organizationId, tenancy);
    } catch {
      return undefined;
    }
  }

  const service: JobService = {
    async enqueue(tenant, request) {
      if (typeof request !== 'object' || request === null || Array.isArray(request)) {
        throw new JobError('invalid_job', 'request');
      }
      const { executionId, nodeId, ...rest } = request as Record<string, unknown>;
      // Only the two ids: an organization, a user, an attempt, a lease or any payload is refused.
      const extra = Object.keys(rest)[0];
      if (extra !== undefined) throw new JobError('invalid_job', 'request.fields');
      if (typeof nodeId !== 'string') throw new JobError('invalid_job', 'nodeId');
      const organizationId = await organizationOf(tenant);
      authorize(tenant, organizationId, 'execution.start');
      if (!isExecutionId(executionId)) throw new JobError('execution_not_found');
      const execution = await executions.find(organizationId, executionId);
      if (execution?.organizationId !== organizationId) {
        throw new JobError('execution_not_found');
      }
      if (
        isTerminal(execution.status) ||
        execution.mode === 'plan' ||
        execution.status !== 'running' ||
        execution.startedAt === undefined
      ) {
        throw new JobError('execution_not_runnable', execution.status);
      }
      const node = execution.nodes.find((n) => n.id === nodeId);
      if (node?.status !== 'pending') throw new JobError('node_not_runnable');
      const at = now();
      const job = newJob(
        {
          organizationId: execution.organizationId,
          executionId: execution.id,
          nodeId: node.id,
          attempt: node.attempt ?? 1,
          correlationId:
            requestId !== undefined && isCorrelationId(requestId) ? requestId : randomUUID(),
        },
        iso(at),
      );
      const created = await jobs.create({
        job,
        events: [
          jobEvent(
            { action: 'execution.job_enqueued', result: 'success', actor: actorOf(tenant) },
            job,
            undefined,
            at,
          ),
        ],
      });
      if (created === 'created') {
        log(job)?.info('job enqueued');
        return job;
      }
      return jobIn(organizationId, job.id);
    },

    async get(tenant, id) {
      return jobIn(await organizationOf(tenant), id);
    },

    async acquire(jobId, workerId) {
      if (!isJobId(jobId)) throw new JobError('job_not_found');
      if (!isWorkerId(workerId)) throw new JobError('invalid_job', 'workerId');
      const job = await jobs.find(jobId);
      if (job === undefined) throw new JobError('job_not_found');
      if (job.state === 'cancelled') throw new JobError('job_cancelled');
      if (isJobTerminal(job.state)) throw new JobError('job_terminal');
      const execution = await executionOf(job);
      if (execution === undefined) {
        return deny('execution.job_leased', job, undefined, new JobError('job_forbidden'), {
          workerId,
        });
      }
      const tenant = await runtimeTenantOf(execution);
      if (tenant === undefined) {
        return deny(
          'execution.job_leased',
          job,
          execution.userId,
          new JobError('job_forbidden', 'tenant'),
          { workerId },
        );
      }
      if (isTerminal(execution.status)) {
        await cancelEnded(job, runtimeActor(execution.userId));
        throw new JobError('job_cancelled');
      }
      const node = execution.nodes.find((n) => n.id === job.nodeId);
      if (node === undefined) {
        return deny(
          'execution.job_leased',
          job,
          execution.userId,
          new JobError('node_not_runnable'),
          {
            workerId,
          },
        );
      }
      if ((node.attempt ?? 1) !== job.attempt) {
        return deny(
          'execution.job_leased',
          job,
          execution.userId,
          new JobError('job_attempt_mismatch'),
          { workerId },
        );
      }
      if (node.status !== 'pending' && node.status !== 'running') {
        return deny(
          'execution.job_leased',
          job,
          execution.userId,
          new JobError('node_not_runnable'),
          {
            workerId,
          },
        );
      }
      const at = now();
      const leaseId = newLeaseId();
      let leased: ExecutionJob;
      try {
        leased = await jobs.update(job.id, (current) => {
          const next = acquireLease(current, { leaseId, workerId, leaseMs }, iso(at));
          return {
            job: next,
            events: [
              jobEvent(
                { action: 'execution.job_leased', result: 'success', actor: actorOf(tenant) },
                next,
                leaseId,
                at,
              ),
            ],
          };
        });
      } catch (error) {
        if (!isJobError(error)) throw error;
        return deny('execution.job_leased', job, execution.userId, error, { workerId });
      }
      log(leased, { leaseId, workerId })?.info('job leased');
      return Object.freeze({
        job: leased,
        lease: Object.freeze({ jobId: leased.id, leaseId, revision: leased.revision }),
        tenant,
      });
    },

    async finish(claim, outcome) {
      const finish = checkFinish(outcome);
      const proof: unknown = claim?.lease;
      if (
        typeof proof !== 'object' ||
        proof === null ||
        !isJobId((proof as LeaseProof).jobId) ||
        typeof (proof as LeaseProof).leaseId !== 'string' ||
        !Number.isSafeInteger((proof as LeaseProof).revision)
      ) {
        throw new JobError('job_lease_mismatch');
      }
      const lease: LeaseProof = {
        jobId: (proof as LeaseProof).jobId as JobId,
        leaseId: (proof as LeaseProof).leaseId,
        revision: (proof as LeaseProof).revision,
      };
      const job = await jobs.find(lease.jobId);
      if (job === undefined) throw new JobError('job_not_found');
      const execution = await executionOf(job);
      const initiatedBy = execution?.userId;
      // The claim's context must be the one this service issued for this job's execution:
      // a context of another organization, another user, a person or GIA is refused.
      const given = claim.tenant;
      if (
        execution === undefined ||
        !isResolvedTenant(given) ||
        given.actor !== 'runtime' ||
        given.organizationId !== job.organizationId ||
        given.userId !== execution.userId
      ) {
        return deny('execution.job_finished', job, initiatedBy, new JobError('job_forbidden'), {
          leaseId: lease.leaseId,
        });
      }
      const tenant = await runtimeTenantOf(execution);
      if (tenant === undefined) {
        return deny(
          'execution.job_finished',
          job,
          initiatedBy,
          new JobError('job_forbidden', 'tenant'),
          { leaseId: lease.leaseId },
        );
      }
      if (isTerminal(execution.status)) {
        await cancelEnded(job, runtimeActor(execution.userId));
        return deny('execution.job_finished', job, initiatedBy, new JobError('job_cancelled'), {
          leaseId: lease.leaseId,
        });
      }
      const at = now();
      let finished: ExecutionJob;
      try {
        finished = await jobs.update(job.id, (current) => {
          const next = finishJob(current, lease, finish, iso(at));
          return {
            job: next,
            events: [
              jobEvent(
                {
                  action: 'execution.job_finished',
                  result: finish.result === 'succeeded' ? 'success' : 'failure',
                  actor: actorOf(tenant),
                  reason: finish.code,
                },
                next,
                lease.leaseId,
                at,
              ),
            ],
          };
        });
      } catch (error) {
        if (!isJobError(error)) throw error;
        return deny('execution.job_finished', job, initiatedBy, error, { leaseId: lease.leaseId });
      }
      log(finished, { leaseId: lease.leaseId })?.info('job finished', { code: finish.code });
      return finished;
    },

    async cancelForExecution(tenant, executionId) {
      const organizationId = await organizationOf(tenant);
      authorize(tenant, organizationId, 'execution.cancel');
      if (!isExecutionId(executionId)) throw new JobError('execution_not_found');
      const execution = await executions.find(organizationId, executionId);
      if (execution?.organizationId !== organizationId) {
        throw new JobError('execution_not_found');
      }
      if (!isTerminal(execution.status)) throw new JobError('execution_not_ended');
      const cancelled: ExecutionJob[] = [];
      // Job ids are fixed by node and attempt, so every job the execution can have is known.
      for (const node of execution.nodes) {
        for (let attempt = 1; attempt <= MAX_NODE_ATTEMPTS; attempt += 1) {
          const job = await jobs.find(jobIdFor(organizationId, execution.id, node.id, attempt));
          if (job === undefined || isJobTerminal(job.state)) continue;
          const ended = await cancelEnded(job, runtimeActor(execution.userId));
          if (ended !== undefined) cancelled.push(ended);
        }
      }
      return cancelled;
    },
  };
  return Object.freeze(service);
}
