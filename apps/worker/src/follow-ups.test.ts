import { createServiceIdentityVerifier } from '@melonoffice/auth';
import { ConversationError, type FollowUpTask } from '@melonoffice/conversations';
import { createLogger } from '@melonoffice/observability';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp, RUN_JOB_PATH } from './app.js';
import { createCloudTasksScheduler, METADATA_TOKEN_URL } from './dispatcher.js';
import {
  createFollowUpHandler,
  FOLLOW_UP_MAX_ATTEMPTS,
  RETRY_COUNT_HEADER,
  RUN_FOLLOW_UP_PATH,
} from './follow-ups.js';

const WORKER_URL = 'https://worker-123456789012.us-central1.run.app';
const INVOKER = 'job-dispatch@melonoffice-test.iam.gserviceaccount.com';
const QUEUE = 'projects/melonoffice-test/locations/us-central1/queues/execution-jobs';
const TASK = {
  organizationId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  followUpId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  schedule: 2,
};

/** A fake follow-up service: records what the handler asks, answers what the test sets. */
function fakeFollowUps(
  answer: () => Promise<{ kind: string }> = async () => ({ kind: 'due' }),
  failed = true,
) {
  const ran: FollowUpTask[] = [];
  const failedTasks: FollowUpTask[] = [];
  return {
    ran,
    failedTasks,
    service: {
      runDue: async (task: FollowUpTask) => {
        ran.push(task);
        return (await answer()) as never;
      },
      failDue: async (task: FollowUpTask) => {
        failedTasks.push(task);
        return failed;
      },
    },
  };
}

describe('follow-up handler (C5)', () => {
  it('gives up exactly when the queue does: its max_attempts in Terraform', () => {
    const terraform = readFileSync(
      join(import.meta.dirname, '../../../infra/modules/environment/main.tf'),
      'utf8',
    );
    expect(/max_attempts\s*=\s*(\d+)/.exec(terraform)?.[1]).toBe(String(FOLLOW_UP_MAX_ATTEMPTS));
  });

  it('hands exactly { organizationId, followUpId, schedule } to the service', async () => {
    const f = fakeFollowUps();
    const handler = createFollowUpHandler({ followUps: f.service });
    expect(await handler.run(TASK, 0)).toEqual({ status: 200, body: { result: 'due' } });
    expect(f.ran).toEqual([TASK]);
    for (const bad of [
      null,
      [],
      { ...TASK, extra: 1 },
      { ...TASK, schedule: 0 },
      { ...TASK, schedule: 1.5 },
      { ...TASK, organizationId: 'not-a-uuid' },
      { ...TASK, followUpId: 'x' },
      { organizationId: TASK.organizationId, followUpId: TASK.followUpId },
    ]) {
      expect(await handler.run(bad, 0)).toEqual({
        status: 400,
        body: { result: 'invalid_request' },
      });
    }
    expect(f.ran).toHaveLength(1);
  });

  it('answers 200 for a stale, early or ended task, so the queue drops it', async () => {
    for (const kind of ['stale', 'early', 'cancelled', 'not_found']) {
      const handler = createFollowUpHandler({
        followUps: fakeFollowUps(async () => ({ kind })).service,
      });
      expect(await handler.run(TASK, 0)).toEqual({ status: 200, body: { result: kind } });
    }
  });

  it('asks for a retry with 503, and on the last delivery keeps the follow-up as failed', async () => {
    const down = async () => {
      throw new ConversationError('follow_up_concurrency_conflict');
    };
    const f = fakeFollowUps(down);
    const handler = createFollowUpHandler({ followUps: f.service });
    expect(await handler.run(TASK, 0)).toMatchObject({
      status: 503,
      body: { result: 'unavailable' },
    });
    expect(await handler.run(TASK, FOLLOW_UP_MAX_ATTEMPTS - 2)).toMatchObject({ status: 503 });
    expect(f.failedTasks).toEqual([]);
    expect(await handler.run(TASK, FOLLOW_UP_MAX_ATTEMPTS - 1)).toMatchObject({
      status: 200,
      body: { result: 'failed' },
    });
    expect(f.failedTasks).toEqual([TASK]);
    // Nothing to mark (already ended or rescheduled): still a retry answer, harmless.
    const none = fakeFollowUps(down, false);
    expect(
      await createFollowUpHandler({ followUps: none.service }).run(
        TASK,
        FOLLOW_UP_MAX_ATTEMPTS - 1,
      ),
    ).toMatchObject({ status: 503 });
  });
});

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

describe('POST /internal/follow-ups/run (C5)', () => {
  async function setup(withFollowUps = true) {
    const signer = await google();
    const f = fakeFollowUps();
    const app = createApp({
      logger: createLogger({ service: 'worker', sink: () => undefined }),
      version: 'test',
      jobs: {
        handler: { run: async () => ({ status: 200, body: { result: 'done' } }) } as never,
        invoker: createServiceIdentityVerifier({
          audience: WORKER_URL,
          allowedEmails: [INVOKER],
          keys: signer.keys,
        }),
        ...(withFollowUps ? { followUps: createFollowUpHandler({ followUps: f.service }) } : {}),
      },
    });
    const deliver = async (body: unknown, headers: Record<string, string> = {}, token?: string) => {
      const response = await app.request(RUN_FOLLOW_UP_PATH, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token ?? (await signer.token())}`,
          ...headers,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    return { signer, f, deliver, app };
  }

  it('runs only for the invoker, with the same checks as jobs', async () => {
    const w = await setup();
    expect(await w.deliver(TASK)).toEqual({ status: 200, body: { result: 'due' } });
    expect(
      (
        await w.deliver(
          TASK,
          {},
          await w.signer.token({ email: 'other@x.iam.gserviceaccount.com' }),
        )
      ).status,
    ).toBe(403);
    expect((await w.deliver(TASK, { authorization: '' })).status).toBe(401);
    expect((await w.deliver(TASK, { 'content-type': 'text/plain' })).status).toBe(400);
    expect(w.f.ran).toHaveLength(1);
  });

  it('passes the queue’s retry count, and is refused where follow-ups are not configured', async () => {
    const w = await setup();
    w.f.service.runDue = async () => {
      throw new Error('down');
    };
    expect(
      await w.deliver(TASK, { [RETRY_COUNT_HEADER]: String(FOLLOW_UP_MAX_ATTEMPTS - 1) }),
    ).toMatchObject({ status: 200, body: { result: 'failed' } });
    expect((await w.deliver(TASK, { [RETRY_COUNT_HEADER]: 'nope' })).status).toBe(503);
    const none = await setup(false);
    expect(await none.deliver(TASK)).toEqual({
      status: 503,
      body: { error: 'follow_ups_not_configured' },
    });
    // The job route is a different route: a follow-up task never runs a job.
    expect(RUN_FOLLOW_UP_PATH).not.toBe(RUN_JOB_PATH);
  });
});

describe('Cloud Tasks scheduler (C5)', () => {
  it('queues a task for a later time on the same queue, target and invoker', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const http = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return String(input) === METADATA_TOKEN_URL
        ? Response.json({ access_token: 'access-token-1', expires_in: 3600 })
        : Response.json({ name: `${QUEUE}/tasks/1` });
    }) as typeof fetch;
    const scheduler = createCloudTasksScheduler({
      queue: QUEUE,
      targetUrl: `${WORKER_URL}${RUN_FOLLOW_UP_PATH}`,
      audience: WORKER_URL,
      invokerEmail: INVOKER,
      dispatchDeadlineSeconds: 900,
      fetch: http,
    });
    await scheduler.schedule(TASK, new Date('2026-09-29T15:00:00Z'));
    const { task } = JSON.parse(String(calls[1]?.init?.body)) as {
      task: {
        name?: string;
        scheduleTime: string;
        httpRequest: { url: string; body: string; oidcToken: Record<string, string> };
      };
    };
    expect(calls[1]?.url).toBe(`https://cloudtasks.googleapis.com/v2/${QUEUE}/tasks`);
    expect(task.name).toBeUndefined();
    expect(task.scheduleTime).toBe('2026-09-29T15:00:00.000Z');
    expect(task.httpRequest.url).toBe(`${WORKER_URL}${RUN_FOLLOW_UP_PATH}`);
    expect(task.httpRequest.oidcToken).toEqual({
      serviceAccountEmail: INVOKER,
      audience: WORKER_URL,
    });
    // Codes only: never a name, a title or a phone number.
    expect(JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString())).toEqual(TASK);
    await expect(scheduler.schedule(TASK, new Date('nope'))).rejects.toThrow(
      'Invalid schedule time',
    );
  });
});
