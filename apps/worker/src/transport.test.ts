import type { JobId } from '@melonoffice/domain';
import { JobError } from '@melonoffice/jobs';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createCloudTasksDispatcher, DispatchError, METADATA_TOKEN_URL } from './dispatcher.js';
import { createJobHandler } from './handler.js';

const JOB = '0f8fad5b-d9cb-469f-a165-70867728950e' as JobId;
const QUEUE = 'projects/melonoffice-test/locations/us-central1/queues/execution-jobs';
const WORKER_URL = 'https://worker-123456789012.us-central1.run.app';
const INVOKER = 'job-dispatch@melonoffice-test.iam.gserviceaccount.com';

function fakeHttp(answers: { token?: () => Response; tasks?: () => Response } = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === METADATA_TOKEN_URL) {
      return (
        answers.token?.() ??
        Response.json({ access_token: 'access-token-1', expires_in: 3600, token_type: 'Bearer' })
      );
    }
    return answers.tasks?.() ?? Response.json({ name: `${QUEUE}/tasks/123` });
  }) as typeof fetch;
  return { http, calls };
}

const dispatcherWith = (http: typeof fetch) =>
  createCloudTasksDispatcher({
    queue: QUEUE,
    targetUrl: `${WORKER_URL}/internal/jobs/run`,
    audience: WORKER_URL,
    invokerEmail: INVOKER,
    dispatchDeadlineSeconds: 900,
    fetch: http,
    now: () => new Date('2026-09-27T12:00:00Z'),
  });

describe('Cloud Tasks dispatcher', () => {
  it('creates a task carrying exactly { jobId }, with an OIDC token for the invoker', async () => {
    const { http, calls } = fakeHttp();
    await dispatcherWith(http).dispatch(JOB);
    expect(calls[0]).toMatchObject({
      url: METADATA_TOKEN_URL,
      init: { headers: { 'Metadata-Flavor': 'Google' } },
    });
    const create = calls[1];
    expect(create?.url).toBe(`https://cloudtasks.googleapis.com/v2/${QUEUE}/tasks`);
    expect(create?.init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer access-token-1' },
    });
    const { task } = JSON.parse(String(create?.init?.body)) as {
      task: {
        name?: string;
        dispatchDeadline: string;
        httpRequest: {
          url: string;
          httpMethod: string;
          body: string;
          oidcToken: { serviceAccountEmail: string; audience: string };
        };
      };
    };
    // No task name: a released job must be deliverable again under the same id.
    expect(task.name).toBeUndefined();
    expect(task.dispatchDeadline).toBe('900s');
    expect(task.httpRequest).toMatchObject({
      url: `${WORKER_URL}/internal/jobs/run`,
      httpMethod: 'POST',
      oidcToken: { serviceAccountEmail: INVOKER, audience: WORKER_URL },
    });
    expect(JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString())).toEqual({
      jobId: JOB,
    });
  });

  it('reuses the access token until it nears expiry', async () => {
    const { http, calls } = fakeHttp();
    const dispatcher = dispatcherWith(http);
    await dispatcher.dispatch(JOB);
    await dispatcher.dispatch(JOB);
    expect(calls.filter((c) => c.url === METADATA_TOKEN_URL)).toHaveLength(1);
  });

  it('fails with a code, never with the response body', async () => {
    const leaky = () => new Response('secret echo', { status: 403 });
    for (const [answers, code] of [
      [{ token: leaky }, 'token_unavailable'],
      [{ tasks: leaky }, 'enqueue_failed'],
    ] as const) {
      const { http } = fakeHttp(answers);
      const error = await dispatcherWith(http)
        .dispatch(JOB)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DispatchError);
      expect((error as DispatchError).code).toBe(code);
      expect(String(error)).not.toContain('secret echo');
    }
    const offline = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const error = await dispatcherWith(offline)
      .dispatch(JOB)
      .catch((e: unknown) => e);
    expect((error as DispatchError).code).toBe('token_unavailable');
  });

  it('refuses a bad queue, URL, invoker or deadline at start', () => {
    const base = {
      queue: QUEUE,
      targetUrl: `${WORKER_URL}/internal/jobs/run`,
      audience: WORKER_URL,
      invokerEmail: INVOKER,
      dispatchDeadlineSeconds: 900,
    };
    expect(() => createCloudTasksDispatcher({ ...base, queue: 'queues/x' })).toThrow();
    expect(() => createCloudTasksDispatcher({ ...base, targetUrl: 'http://worker' })).toThrow();
    expect(() =>
      createCloudTasksDispatcher({ ...base, invokerEmail: 'someone@gmail.com' }),
    ).toThrow();
    expect(() => createCloudTasksDispatcher({ ...base, dispatchDeadlineSeconds: 0 })).toThrow();
  });
});

describe('worker runtime configuration', () => {
  const full = {
    FIRESTORE_PROJECT_ID: 'melonoffice-test',
    DEPLOYMENT_ENVIRONMENT: 'dev',
    JOB_LEASE_MS: '900000',
    JOB_QUEUE: QUEUE,
    WORKER_URL,
    JOB_INVOKER_EMAIL: INVOKER,
  };

  it('is off when none of it is set: health only', () => {
    expect(loadConfig({}).runtime).toBeUndefined();
  });

  it('reads all of it', () => {
    expect(loadConfig(full).runtime).toEqual({
      firestoreProjectId: 'melonoffice-test',
      environment: 'dev',
      leaseMs: 900_000,
      queue: QUEUE,
      workerUrl: WORKER_URL,
      invokerEmail: INVOKER,
    });
  });

  it('refuses to start with part of it, or invalid values', () => {
    expect(() => loadConfig({ JOB_QUEUE: QUEUE })).toThrow('Incomplete runtime configuration');
    expect(() => loadConfig({ ...full, DEPLOYMENT_ENVIRONMENT: 'local' })).toThrow();
    expect(() => loadConfig({ ...full, JOB_LEASE_MS: '1000' })).toThrow('JOB_LEASE_MS');
    expect(() => loadConfig({ ...full, JOB_LEASE_MS: '3600000' })).toThrow('JOB_LEASE_MS');
    expect(() => loadConfig({ ...full, WORKER_URL: 'http://worker' })).toThrow('WORKER_URL');
  });
});

describe('job handler status mapping', () => {
  const handler = (acquire: () => Promise<never>) =>
    createJobHandler({
      jobs: { acquire },
      runtime: {
        advance: async () => {
          throw new Error('not reached');
        },
      },
      workerId: 'worker-1',
    });

  it.each([
    ['job_not_found', 200, 'refused'],
    ['job_terminal', 200, 'refused'],
    ['job_cancelled', 200, 'refused'],
    ['job_forbidden', 200, 'refused'],
    ['execution_not_found', 200, 'refused'],
    ['organization_inactive', 200, 'refused'],
    ['job_lease_held', 409, 'retry_later'],
    ['job_concurrency_conflict', 409, 'retry_later'],
  ] as const)('acquire refusal %s answers %i', async (code, status, result) => {
    const answer = await handler(async () => {
      throw new JobError(code);
    }).run({ jobId: JOB }, 'req-1');
    expect(answer).toEqual({ status, body: { result, code } });
  });
});

describe('worker architecture', () => {
  const root = join(import.meta.dirname, '..');
  const sources = readdirSync(join(root, 'src')).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );
  const text = (file: string) => readFileSync(join(root, 'src', file), 'utf8');

  it('depends on no provider SDK, HTTP client library or planner', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const allowed = ['@google-cloud/firestore', '@hono/node-server', 'hono'];
    for (const dependency of Object.keys(manifest.dependencies)) {
      expect(dependency.startsWith('@melonoffice/') || allowed.includes(dependency)).toBe(true);
    }
    // Credits are here only for the AI Gateway's charge per model call (CV-6B, ADR-0043).
    for (const forbidden of ['@melonoffice/workflows', '@melonoffice/billing']) {
      expect(Object.keys(manifest.dependencies)).not.toContain(forbidden);
    }
    // The worker never plans: from planning it takes only the plan conductor, which starts the
    // steps of a plan a person approved and closes it (ADR-0070), and the shape of the evaluator
    // that decides its condition steps through the Decision Engine (ADR-0075). No planner,
    // validator, delegation or plan decision is reachable from its code.
    const PLAN_RUNS = ['PlanRepository', 'createPlanConductor', 'planStepOf', 'ConditionEvaluator'];
    for (const file of sources) {
      // Providers are reached only through their @melonoffice adapter packages, never an SDK.
      expect(text(file)).not.toMatch(
        /from '[^']*(openai|anthropic|@google\/genai|generative-ai|vertexai|elevenlabs|@google-cloud\/tasks)[^']*'/i,
      );
      expect(text(file)).not.toMatch(/from '@melonoffice\/workflows'/);
      for (const [, names] of text(file).matchAll(
        /import\s*(?:type\s*)?\{([^}]*)\}\s*from '@melonoffice\/planning'/g,
      )) {
        const imported = (names ?? '')
          .split(',')
          .map((n) => n.replace(/^\s*type\s+/, '').trim())
          .filter((n) => n.length > 0);
        for (const name of imported) expect(PLAN_RUNS).toContain(name);
      }
      expect(text(file)).not.toMatch(/import \* as \w+ from '@melonoffice\/planning'/);
    }
  });

  it('has a thin handler: it only leases and hands the proof to the runtime', () => {
    const handler = text('handler.ts');
    const imports = [...handler.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual([
      '@melonoffice/jobs',
      '@melonoffice/observability',
      '@melonoffice/runtime',
    ]);
    // It never changes a node or an execution, never runs a tool or model, never decides.
    expect(handler).not.toMatch(
      /changeStatus|runtimeChange|changeNode|recordVerification|invoke\(|generate\(|approve|reject|finish\(|release\(/,
    );
  });

  it('reaches tools only through the gate and models only through the gateway', () => {
    for (const file of sources) {
      // No tool executor implementation and no provider adapter or credential in the worker.
      expect(text(file)).not.toMatch(/ProviderAdapter|ProviderCredential|CredentialResolver/);
      expect(text(file)).not.toMatch(/\.execute\(/);
    }
    // Only the composition builds the gate and the gateway. The server passes the real tool
    // catalogue with the conversation agent's executors only (ADR-0043), and the official model
    // adapters, Vertex AI (D-7), DeepSeek (ADR-0072) and NVIDIA (ADR-0080), each only with its own
    // settings, with
    // credits at the approved rate (D-12); without any of them it registers no adapter and no
    // credits.
    const server = text('server.ts');
    expect(server).toMatch(/createToolRegistry\(TOOL_CATALOGUE\), executors: agents\.executors/);
    expect(server).toMatch(/adapters: \[\]/);
    expect([...server.matchAll(/create\w*Adapter\(/g)].map((m) => m[0]).sort()).toEqual([
      'createDeepSeekAdapter(',
      'createNvidiaAdapter(',
      'createVertexAIAdapter(',
      'createWhatsAppAdapter(',
    ]);
    // Credits: the gateway's, at the approved rate, and the Forecasting Engine's (ADR-0059), the
    // same credit service charging whole credits per run.
    expect([...server.matchAll(/credits:/g)]).toHaveLength(2);
    expect(server).toMatch(/credits: createCreditService\(/);
    expect(server).toMatch(/rate: CREDIT_RATE/);
    const agents = text('agents.ts');
    expect(
      [...agents.matchAll(/executors\.(\w+) =|^\s+(\w+): create\w+Executor\(/gm)]
        .map((m) => m[1] ?? m[2])
        .sort(),
    ).toEqual(['channel', 'conversation']);
  });
});
