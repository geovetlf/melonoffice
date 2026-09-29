import type { Firestore } from '@google-cloud/firestore';
import { createProviderRegistry } from '@melonoffice/ai-gateway';
import { InMemoryApprovalRepository } from '@melonoffice/approvals';
import { createAuditService, InMemoryAuditStore, type AuditEvent } from '@melonoffice/audit';
import { createServiceIdentityVerifier, type AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  departmentIdOf,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  DepartmentTypeId,
  Execution,
  ExecutionNodeType,
  InitialBilling,
  IsoTimestamp,
  JobId,
  Organization,
  Specialist,
  SubscriptionId,
  ToolDefinition,
  ToolVersion,
  UserId,
} from '@melonoffice/domain';
import { createExecutionService, InMemoryExecutionRepository } from '@melonoffice/execution';
import {
  AUDIT_LOGS,
  FirestoreApprovalRepository,
  FirestoreAuditStore,
  FirestoreDepartmentRepository,
  FirestoreExecutionRepository,
  FirestoreJobRepository,
  FirestoreSpecialistRepository,
  FirestoreTenancyStore,
  fromAuditDocument,
  type AuditDocument,
} from '@melonoffice/firestore';
import { emulatorFirestore, emulatorHost } from '@melonoffice/firestore/testing';
import { InMemoryJobRepository, isJobError, jobIdFor } from '@melonoffice/jobs';
import { createLogger } from '@melonoffice/observability';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  applySpecialistStatus,
  createSkillCatalogue,
  createSpecialistService,
  InMemorySpecialistRepository,
  newSpecialist,
} from '@melonoffice/specialists';
import { createOrganization, InMemoryTenancyStore, resolveTenant } from '@melonoffice/tenancy';
import {
  createToolRegistry,
  TOOL_CATALOGUE,
  type ToolExecutionContext,
  type ToolExecutor,
} from '@melonoffice/tools';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { describe, expect, it } from 'vitest';
import { createApp, RUN_JOB_PATH } from './app.js';
import { createJobHandler } from './handler.js';
import { createWorkerRuntime, type WorkerStores } from './runtime.js';

const T0 = new Date('2026-09-27T12:00:00Z');
const AT = T0.toISOString() as IsoTimestamp;
const LEASE_MS = 60_000;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const WORKER_URL = 'https://worker-123456789012.us-central1.run.app';
const INVOKER = 'job-dispatch@melonoffice-test.iam.gserviceaccount.com';

const BILLING = (organization: Organization): InitialBilling => {
  const subscriptionId = `sub-${organization.id}` as SubscriptionId;
  const at = organization.createdAt;
  return {
    account: { organizationId: organization.id, subscriptionId, createdAt: at, updatedAt: at },
    subscription: {
      id: subscriptionId,
      organizationId: organization.id,
      plan: { id: 'test-plan', version: 1 },
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  };
};

const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

// Test only: MelonOffice's real tool catalogue is empty (ADR-0026).
const tool = (id: string, overrides: Partial<ToolVersion> = {}): ToolDefinition => ({
  id: id as ToolDefinition['id'],
  status: 'active',
  versions: [
    {
      toolId: id as ToolVersion['toolId'],
      version: 1,
      nameKey: `tools.${id}.name` as ToolVersion['nameKey'],
      descriptionKey: `tools.${id}.description` as ToolVersion['descriptionKey'],
      category: 'test',
      action: 'run',
      mutating: false,
      inputSchema: {
        type: 'object',
        properties: { subject: { type: 'string', maxLength: 200, minLength: 1 } },
        required: ['subject'],
      },
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 0 } },
        required: ['count'],
      },
      permissions: ['organization.read'],
      credentials: [],
      riskLevel: 'low',
      approvalPolicy: 'auto',
      approvalTtlSeconds: 600,
      timeoutMs: 1000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'internal', id: 'fixture' },
      environments: ['dev'],
      ...overrides,
    },
  ],
});
const TOOLS: readonly ToolDefinition[] = [tool('lookup')];

/** Google's signing key and the Cloud Tasks OIDC token it would sign, for tests. */
async function google() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'google', alg: 'RS256', use: 'sig' };
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    keys: createLocalJWKSet({ keys: [jwk] }),
    async token(claims: Record<string, unknown> = {}) {
      return new SignJWT({
        iss: 'https://accounts.google.com',
        aud: WORKER_URL,
        sub: '1234567890',
        email: INVOKER,
        email_verified: true,
        iat: nowSeconds - 10,
        exp: nowSeconds + 3600,
        ...claims,
      } as JWTPayload)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'google' })
        .sign(privateKey);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Storage: memory, and the Firestore emulator when it runs.

type Stores = WorkerStores & { readonly events: () => Promise<readonly AuditEvent[]> };

function memoryStores(now: () => Date): Stores {
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  return {
    tenancy: new InMemoryTenancyStore(now, audit, undefined, departments),
    departments,
    specialists: new InMemorySpecialistRepository(),
    executions: new InMemoryExecutionRepository(audit),
    approvals: new InMemoryApprovalRepository(audit),
    jobs: new InMemoryJobRepository(audit),
    audit,
    events: async () => audit.events(),
  };
}

function firestoreStores(now: () => Date): Stores {
  const db: Firestore = emulatorFirestore();
  return {
    tenancy: new FirestoreTenancyStore(db, now),
    departments: new FirestoreDepartmentRepository(db),
    specialists: new FirestoreSpecialistRepository(db),
    executions: new FirestoreExecutionRepository(db),
    approvals: new FirestoreApprovalRepository(db),
    jobs: new FirestoreJobRepository(db),
    audit: new FirestoreAuditStore(db),
    async events() {
      const snapshot = await db.collection(AUDIT_LOGS).orderBy('occurredAt').get();
      return snapshot.docs.map((doc) => fromAuditDocument(doc.id, doc.data() as AuditDocument));
    },
  };
}

const STORES: [string, (now: () => Date) => Stores][] = [
  ['memory', memoryStores],
  ...(emulatorHost ? [['firestore', firestoreStores] as [string, typeof memoryStores]] : []),
];

interface WorldOptions {
  /** `production`: the real, empty tool and model catalogues, and no credits (D-7, D-12). */
  readonly catalogue?: 'fixture' | 'production';
  /** Runs inside the tool, once per call. */
  readonly hook?: (context: ToolExecutionContext) => Promise<void>;
}

describe.each(STORES)('worker job delivery with storage in %s', (_storage, createStores) => {
  async function world(options: WorldOptions = {}) {
    let clock = new Date(T0);
    // A server clock that moves a millisecond per read, so stored events have a strict order.
    const now = () => {
      clock = new Date(clock.getTime() + 1);
      return clock;
    };
    const stores = createStores(now);
    const provision = (organization: Organization) =>
      provisionDepartments(organization, DEFAULT_DEPARTMENT_CATALOGUE);
    const a = await createOrganization(as(ALICE), { name: 'A' }, stores.tenancy, {
      billing: BILLING,
      credits: openWallet,
      departments: provision,
    });
    const b = await createOrganization(as(BOB), { name: 'B' }, stores.tenancy, {
      billing: BILLING,
      credits: openWallet,
      departments: provision,
    });
    const orgA = a.organization.id;
    const authorization = createAuthorizationService();
    const audit = createAuditService(stores.audit, now);
    const specialists = createSpecialistService({
      repository: stores.specialists,
      departments: stores.departments,
      organizations: stores.tenancy,
      authorization,
    });

    const toolCalls: ToolExecutionContext[] = [];
    const executor: ToolExecutor = {
      async execute(context) {
        toolCalls.push(context);
        await options.hook?.(context);
        return { status: 'success', output: { count: 3 } };
      },
    };
    const production = options.catalogue === 'production';
    const dispatched: JobId[] = [];
    const { jobs, runtime } = createWorkerRuntime({
      stores,
      environment: 'dev',
      leaseMs: LEASE_MS,
      tools: production
        ? { registry: createToolRegistry(TOOL_CATALOGUE), executors: {} }
        : {
            registry: createToolRegistry(TOOLS),
            executors: { fixture: executor },
            // The fixture skill that grants every fixture tool (SK-2, ADR-0083).
            skills: createSkillCatalogue([
              {
                id: 'fixture_work',
                version: 1,
                nameKey: 'fixture',
                descriptionKey: 'fixture',
                tools: TOOLS.map((t) => ({ id: t.id, versions: [1] })),
                actions: [],
                reads: [],
              } as never,
            ]),
          },
      ai: createProviderRegistry({ providers: [], models: [], adapters: [] }),
      work: {
        toolInput: async () => ({ subject: 'Weekly summary' }),
        agentWork: async () => undefined,
      },
      dispatcher: { dispatch: async (id) => void dispatched.push(id) },
      now,
    });
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'worker',
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    const signer = await google();
    const invoker = createServiceIdentityVerifier({
      audience: WORKER_URL,
      allowedEmails: [INVOKER],
      keys: signer.keys,
    });
    const handlerFor = (workerId: string) => createJobHandler({ jobs, runtime, workerId, logger });
    const app = createApp({
      logger,
      version: 'test',
      jobs: { handler: handlerFor('worker-1'), invoker },
    });

    const executions = createExecutionService({
      repository: stores.executions,
      organizations: stores.tenancy,
      assignments: specialists.assignments,
      authorization,
      audit,
      now,
      requestId: 'req-owner',
    });
    const tenantA = await resolveTenant(as(ALICE), orgA, stores.tenancy);
    const tenantB = await resolveTenant(as(BOB), b.organization.id, stores.tenancy);

    async function seed(): Promise<Specialist> {
      const departmentId = departmentIdOf(orgA, 'research' as DepartmentTypeId);
      const write = newSpecialist(
        {
          organizationId: orgA,
          displayName: 'María',
          configuration: {
            departmentId,
            mainRoleId: 'operations_assistant',
            roleVersion: 1,
            capabilities: [],
            skills: [{ id: 'fixture_work', version: 1 }],
            tools: TOOLS.map((t) => ({ id: t.id, version: 1 })),
            permissions: ['organization.read'],
            policies: {},
          } as never,
        },
        must(await stores.departments.find(orgA, departmentId)),
        ALICE,
        AT,
      );
      await stores.specialists.create(write);
      return stores.specialists.update(orgA, write.specialist.identity.id, (s) =>
        applySpecialistStatus(s, { from: s.status, to: 'active' }, AT),
      );
    }

    /** Alice's started execution, with its first job queued: what the control plane will do. */
    async function queued(
      nodes: readonly {
        id: string;
        type?: ExecutionNodeType;
        tool?: string;
        dependsOn?: string[];
      }[],
    ): Promise<{ execution: Execution; jobId: JobId }> {
      const specialist = await seed();
      const created = await executions.create(tenantA, {
        mode: 'execute',
        input: { type: 'task', id: 'task-1' },
        specialistId: specialist.identity.id,
        specialistVersion: specialist.version,
        departmentId: specialist.configuration.departmentId,
        versionSnapshot: {
          schemaVersion: 1,
          components: [{ kind: 'specialist', id: specialist.identity.id, version: '1' }],
        },
        nodes: nodes.map((n) => ({
          id: n.id,
          type: n.type ?? (n.tool === undefined ? 'agent' : 'tool'),
          label: n.id,
          ...(n.tool === undefined ? {} : { tool: { id: n.tool, version: 1 } }),
          ...(n.dependsOn === undefined ? {} : { dependsOn: n.dependsOn }),
        })),
      });
      const execution = await executions.start(tenantA, created.id);
      const job = await runtime.kickoff(tenantA, execution.id);
      return { execution, jobId: job.id };
    }

    /** One Cloud Tasks delivery: POST { jobId } with the invoker's OIDC token. */
    async function deliver(
      body: unknown,
      headers: Record<string, string> | 'no-auth' = {},
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const auth = headers === 'no-auth' ? {} : { authorization: `Bearer ${await signer.token()}` };
      const response = await app.request(RUN_JOB_PATH, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...auth,
          ...(headers === 'no-auth' ? {} : headers),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }

    const jobOf = (jobId: JobId) => jobs.get(tenantA, jobId);
    const get = (id: string) => executions.get(tenantA, id);
    const eventsOf = async (executionId: string, prefix = '') =>
      (await stores.events()).filter(
        (e) => e.target?.id === executionId && e.action.startsWith(prefix),
      );

    return {
      stores,
      orgA,
      tenantA,
      tenantB,
      app,
      signer,
      jobs,
      runtime,
      executions,
      toolCalls,
      dispatched,
      lines,
      handlerFor,
      queued,
      deliver,
      jobOf,
      get,
      eventsOf,
      advanceClock: (ms: number) => {
        clock = new Date(clock.getTime() + ms);
      },
    };
  }

  it('runs a delivered job through the runtime: the tool runs once, via the gate', async () => {
    const w = await world();
    const { execution, jobId } = await w.queued([
      { id: 'n0', tool: 'lookup' },
      { id: 'n1', tool: 'lookup', dependsOn: ['n0'] },
    ]);
    const response = await w.deliver({ jobId });
    expect(response).toEqual({
      status: 200,
      body: { result: 'advanced', outcome: 'progressed', code: 'node_completed' },
    });
    expect(w.toolCalls).toHaveLength(1);
    // The gate ran it for the execution's own organization, node and runtime actor.
    expect(w.toolCalls[0]).toMatchObject({
      organizationId: w.orgA,
      executionId: execution.id,
      nodeId: 'n0',
    });
    expect((await w.get(execution.id)).nodes.map((n) => n.status)).toEqual([
      'completed',
      'pending',
    ]);
    expect(await w.jobOf(jobId)).toMatchObject({ state: 'succeeded' });
    // The next node's job is queued and handed to the transport by id only.
    const next = jobIdFor(w.orgA, execution.id, 'n1', 1);
    expect(w.dispatched).toEqual([jobId, next]);
    // Node changes are audited as the runtime, initiated by the execution's user.
    const changed = await w.eventsOf(execution.id, 'execution.node_changed');
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every((e) => e.actor.type === 'system' && e.actor.initiatedBy === ALICE)).toBe(
      true,
    );
    // The second node, then verification: no verifier in the worker yet, so it stays verifying.
    expect(await w.deliver({ jobId: next })).toEqual({
      status: 200,
      body: { result: 'advanced', outcome: 'verification_pending', code: 'verification_pending' },
    });
    expect((await w.get(execution.id)).status).toBe('verifying');
    expect(w.toolCalls).toHaveLength(2);
  });

  it('refuses a delivery without a token, with a bad token or from another identity', async () => {
    const w = await world();
    const { execution, jobId } = await w.queued([{ id: 'n0', tool: 'lookup' }]);
    const before = await w.jobOf(jobId);
    expect(await w.deliver({ jobId }, 'no-auth')).toEqual({
      status: 401,
      body: { error: 'missing_token' },
    });
    for (const token of [
      'not-a-token',
      await w.signer.token({ email: 'someone@melonoffice-test.iam.gserviceaccount.com' }),
      await w.signer.token({ aud: 'https://api.example' }),
      await w.signer.token({ exp: Math.floor(Date.now() / 1000) - 3600 }),
      await w.signer.token({ email_verified: false }),
    ]) {
      expect(await w.deliver({ jobId }, { authorization: `Bearer ${token}` })).toEqual({
        status: 403,
        body: { error: 'forbidden' },
      });
    }
    // Nothing was leased or run.
    expect(await w.jobOf(jobId)).toEqual(before);
    expect(w.toolCalls).toHaveLength(0);
    expect((await w.get(execution.id)).nodes[0]?.status).toBe('pending');
  });

  it('takes nothing but the job id: organization, user, attempt, actor or lease fields are refused', async () => {
    const w = await world();
    const { jobId } = await w.queued([{ id: 'n0', tool: 'lookup' }]);
    const before = await w.jobOf(jobId);
    for (const extra of [
      { organizationId: w.tenantB.organizationId },
      { userId: BOB },
      { attempt: 2 },
      { actor: 'user' },
      { leaseId: 'x', revision: 0 },
      { approved: true },
      { nodeId: 'n0', status: 'completed' },
    ]) {
      expect(await w.deliver({ jobId, ...extra })).toEqual({
        status: 400,
        body: { result: 'invalid_request', code: 'invalid_request' },
      });
    }
    for (const body of [{}, { jobId: 'not-a-job' }, [jobId], jobId, null]) {
      expect((await w.deliver(body)).status).toBe(400);
    }
    expect(await w.deliver('{"jobId":')).toEqual({
      status: 400,
      body: { result: 'invalid_request', code: 'invalid_json' },
    });
    expect(await w.deliver({ jobId }, { 'content-type': 'text/plain' })).toEqual({
      status: 400,
      body: { result: 'invalid_request', code: 'content_type' },
    });
    expect(await w.deliver({ jobId, pad: 'x'.repeat(2000) })).toEqual({
      status: 400,
      body: { result: 'invalid_request', code: 'body_too_large' },
    });
    expect(await w.jobOf(jobId)).toEqual(before);
    expect(w.toolCalls).toHaveLength(0);
  });

  it('has no route to change a node, approve, complete or verify', async () => {
    const w = await world();
    const { jobId } = await w.queued([{ id: 'n0', tool: 'lookup' }]);
    const token = await w.signer.token();
    for (const path of [
      '/internal/jobs/changeNode',
      '/internal/jobs/approve',
      '/internal/jobs/complete',
      '/internal/jobs/verify',
      `/internal/jobs/${jobId}/run`,
      '/worker/changeNode',
    ]) {
      const response = await w.app.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      expect(response.status).toBe(404);
    }
    expect((await w.app.request(RUN_JOB_PATH)).status).toBe(404);
    expect(w.toolCalls).toHaveLength(0);
  });

  it('acknowledges an unknown job without retry and without running anything', async () => {
    const w = await world();
    expect(await w.deliver({ jobId: '99999999-9999-4999-8999-999999999999' })).toEqual({
      status: 200,
      body: { result: 'refused', code: 'job_not_found' },
    });
  });

  it('never runs a job twice: a repeated delivery after it finished is a no-op', async () => {
    const w = await world();
    const { jobId } = await w.queued([{ id: 'n0', tool: 'lookup' }]);
    expect((await w.deliver({ jobId })).body).toMatchObject({ result: 'advanced' });
    for (let i = 0; i < 3; i += 1) {
      expect(await w.deliver({ jobId })).toEqual({
        status: 200,
        body: { result: 'refused', code: 'job_terminal' },
      });
    }
    expect(w.toolCalls).toHaveLength(1);
    expect(await w.jobOf(jobId)).toMatchObject({ state: 'succeeded' });
  });

  it.each([2, 5, 10])(
    'of %i simultaneous deliveries of one job, exactly one runs it',
    async (n) => {
      const w = await world();
      const { execution, jobId } = await w.queued([{ id: 'n0', tool: 'lookup' }]);
      const responses = await Promise.all(Array.from({ length: n }, () => w.deliver({ jobId })));
      const ran = responses.filter(
        (r) => r.body.result === 'advanced' && r.body.outcome !== 'duplicate',
      );
      expect(ran).toHaveLength(1);
      // The others exit safely: the lease is held (retry later) or the job already ended.
      for (const r of responses.filter((x) => !ran.includes(x))) {
        expect(
          (r.status === 409 && r.body.result === 'retry_later') ||
            (r.status === 200 && ['refused', 'advanced'].includes(r.body.result as string)),
        ).toBe(true);
      }
      expect(w.toolCalls).toHaveLength(1);
      expect((await w.get(execution.id)).nodes[0]?.status).toBe('completed');
      expect(
        (await w.eventsOf(execution.id, 'execution.node_changed')).filter(
          (e) => e.transition?.to === 'completed',
        ),
      ).toHaveLength(1);
    },
  );

  it('a stale worker whose lease expired cannot run or overwrite the job', async () => {
    const w = await world();
    const { execution, jobId } = await w.queued([{ id: 'n0', tool: 'lookup' }]);
    // Worker A takes the lease, then stalls past its expiry.
    const stale = await w.jobs.acquire(jobId, 'worker-a');
    w.advanceClock(LEASE_MS + 1_000);
    // Worker B's delivery takes the job over and runs it.
    expect((await w.deliver({ jobId })).body).toMatchObject({
      result: 'advanced',
      outcome: 'verification_pending',
    });
    expect(w.toolCalls).toHaveLength(1);
    const done = await w.jobOf(jobId);
    // Worker A wakes up: its turn and its finish are refused, and nothing changes.
    expect(await w.runtime.advance(stale.lease)).toMatchObject({ outcome: 'duplicate' });
    let refused = 'accepted';
    try {
      await w.jobs.finish(stale, { result: 'failed', code: 'late_result' });
    } catch (error) {
      if (!isJobError(error)) throw error;
      refused = error.code;
    }
    expect(refused).not.toBe('accepted');
    expect(await w.jobOf(jobId)).toEqual(done);
    expect(w.toolCalls).toHaveLength(1);
    expect((await w.get(execution.id)).nodes[0]?.status).toBe('completed');
  });

  it('asks for a later delivery while another worker holds a live lease', async () => {
    const w = await world();
    const { jobId } = await w.queued([{ id: 'n0', tool: 'lookup' }]);
    await w.jobs.acquire(jobId, 'worker-a');
    expect(await w.deliver({ jobId })).toEqual({
      status: 409,
      body: { result: 'retry_later', code: 'job_lease_held' },
    });
    expect(w.toolCalls).toHaveLength(0);
  });

  it('a node found running after its worker died is never run again', async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => undefined;
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Worker A's tool call starts and never returns (the instance is lost mid-call).
    const w = await world({
      hook: async () => {
        started();
        await hung;
      },
    });
    const { execution, jobId } = await w.queued([{ id: 'n0', tool: 'lookup' }]);
    const a = w.handlerFor('worker-a').run({ jobId }, 'req-a');
    await running;
    w.advanceClock(LEASE_MS + 1_000);
    // Worker B takes the expired lease over, finds the node running and does not run it again.
    expect(await w.deliver({ jobId })).toEqual({
      status: 200,
      body: { result: 'advanced', outcome: 'awaiting_resolution', code: 'outcome_unknown' },
    });
    expect(w.toolCalls).toHaveLength(1);
    // Worker A's late result is discarded: the node stays unknown for a person to resolve.
    release();
    await a;
    expect(w.toolCalls).toHaveLength(1);
    const node = must((await w.get(execution.id)).nodes[0]);
    expect(node).toMatchObject({ status: 'failed', error: { code: 'outcome_unknown' } });
    expect((await w.get(execution.id)).status).not.toBe('completed');
  });

  it('does not run work for a cancelled execution and cancels its job', async () => {
    const w = await world();
    const { execution, jobId } = await w.queued([{ id: 'n0', tool: 'lookup' }]);
    await w.executions.cancel(w.tenantA, execution.id, 'director_request');
    expect(await w.deliver({ jobId })).toEqual({
      status: 200,
      body: { result: 'refused', code: 'job_cancelled' },
    });
    expect(w.toolCalls).toHaveLength(0);
    expect(await w.jobOf(jobId)).toMatchObject({ state: 'cancelled' });
    expect((await w.get(execution.id)).status).toBe('cancelled');
    // A later delivery of the ended job is a no-op too.
    expect((await w.deliver({ jobId })).body).toMatchObject({ result: 'refused' });
    expect(w.toolCalls).toHaveLength(0);
  });

  it('cancelling while a job runs: the node finishes, nothing new starts', async () => {
    const on: { cancel?: () => Promise<unknown> } = {};
    const w = await world({ hook: async () => void (await on.cancel?.()) });
    const { execution, jobId } = await w.queued([
      { id: 'n0', tool: 'lookup' },
      { id: 'n1', tool: 'lookup', dependsOn: ['n0'] },
    ]);
    on.cancel = () => w.executions.cancel(w.tenantA, execution.id, 'director_request');
    const response = await w.deliver({ jobId });
    expect(response.status).toBe(200);
    expect((await w.get(execution.id)).status).toBe('cancelled');
    expect(w.toolCalls).toHaveLength(1);
    // No job for n1 runs.
    const next = jobIdFor(w.orgA, execution.id, 'n1', 1);
    expect((await w.deliver({ jobId: next })).body).toMatchObject({ result: 'refused' });
    expect(w.toolCalls).toHaveLength(1);
  });

  it('with the real (empty) catalogues, nothing runs: the tool is unknown and models are denied', async () => {
    const w = await world({ catalogue: 'production' });
    const tooling = await w.queued([{ id: 'n0', tool: 'lookup' }]);
    const response = await w.deliver({ jobId: tooling.jobId });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: 'advanced', outcome: 'failed' });
    expect(w.toolCalls).toHaveLength(0);
    expect((await w.get(tooling.execution.id)).status).toBe('failed');
  });

  it('an agent node without work fails safely, and no model is called', async () => {
    const w = await world();
    const { execution, jobId } = await w.queued([{ id: 'n0' }]);
    expect(await w.deliver({ jobId })).toEqual({
      status: 200,
      body: { result: 'advanced', outcome: 'failed', code: 'input_unavailable' },
    });
    expect((await w.get(execution.id)).status).toBe('failed');
  });

  it('answers 503 when storage fails, and a later delivery is safe', async () => {
    const w = await world();
    const { jobId } = await w.queued([{ id: 'n0', tool: 'lookup' }]);
    const broken = createJobHandler({
      jobs: {
        acquire: async () => {
          throw new Error('firestore unavailable');
        },
      },
      runtime: w.runtime,
      workerId: 'worker-b',
    });
    expect(await broken.run({ jobId }, 'req-1')).toEqual({
      status: 503,
      body: { result: 'unavailable', code: 'lease_unavailable' },
    });
    const failing = createJobHandler({
      jobs: w.jobs,
      runtime: {
        advance: async () => {
          throw new Error('firestore unavailable');
        },
      },
      workerId: 'worker-c',
    });
    expect(await failing.run({ jobId }, 'req-2')).toEqual({
      status: 503,
      body: { result: 'unavailable', code: 'run_failed' },
    });
    // The lease worker-c took is still live: a redelivery waits, then takes over after expiry.
    expect((await w.deliver({ jobId })).status).toBe(409);
    w.advanceClock(LEASE_MS + 1_000);
    expect((await w.deliver({ jobId })).body).toMatchObject({ result: 'advanced' });
    expect(w.toolCalls).toHaveLength(1);
  });

  it('logs each delivery with the job, lease and worker, never the token or body', async () => {
    const w = await world();
    const { jobId } = await w.queued([{ id: 'n0', tool: 'lookup' }]);
    const token = await w.signer.token();
    await w.deliver({ jobId }, { authorization: `Bearer ${token}` });
    const text = JSON.stringify(w.lines);
    expect(w.lines).toContainEqual(
      expect.objectContaining({ message: 'job claimed', jobId, workerId: 'worker-1' }),
    );
    expect(w.lines).toContainEqual(
      expect.objectContaining({ message: 'job run', jobId, outcome: 'verification_pending' }),
    );
    expect(text).not.toContain(token);
    expect(text).not.toContain('Weekly summary');
  });
});

describe('a worker without runtime configuration', () => {
  it('refuses every job with 503 and reads nothing', async () => {
    const logger = createLogger({ service: 'worker', sink: () => undefined });
    const app = createApp({ logger, version: 'test' });
    const response = await app.request(RUN_JOB_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: '99999999-9999-4999-8999-999999999999' }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'runtime_not_configured' });
  });
});
