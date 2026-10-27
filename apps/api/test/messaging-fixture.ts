import type { FastifyInstance } from 'fastify';
import type { FileDependencies } from '../src/files/config.js';
import { randomUUID } from 'node:crypto';
import { migrate } from '@ao/database';
import type { Bootstrap, Message } from '@ao/contracts';
import { buildApp } from '../src/app.js';
import { testDatabase } from './database.js';
import { testEmail, verifyFixtureAccount } from './email.js';
import { expect } from 'vitest';
export async function messagingFixture(
  files?: FileDependencies,
  configure?: (app: FastifyInstance) => void,
  options: NonNullable<Parameters<typeof buildApp>[1]> = {},
) {
  const db = await testDatabase();
  await migrate(db);
  const app = await buildApp(db, {
    identityKey: Buffer.alloc(32, 5).toString('base64'),
    ...options,
    email: testEmail(),
    ...(files ? { files } : {}),
  });
  configure?.(app);
  let request = 0;
  const call = (
    session: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        cookie: `ao_session=${session}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      remoteAddress: `127.2.${Math.floor(request / 200)}.${(++request % 200) + 1}`,
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  async function signup(name: string) {
    const address = randomUUID() + '@messages.test';
    const response = await call('', 'POST', '/v1/auth/signup', {
      name,
      email: address,
      password: 'messaging-test-password',
      workspace: name + ' Studio',
    });
    expect(response.statusCode).toBe(201);
    await verifyFixtureAccount(db, address);
    return response.cookies[0]!.value;
  }
  const owner = await signup('Owner'),
    other = await signup('Other');
  const address = randomUUID() + '@messages.test';
  const invitation = await call(owner, 'POST', '/v1/invitations', {
    email: address,
    role: 'member',
  });
  const accepted = await call('', 'POST', '/v1/invitations/accept', {
    token: invitation.json().token,
    name: 'Teammate',
    password: 'messaging-test-password',
  });
  expect(accepted.statusCode).toBe(201);
  await verifyFixtureAccount(db, address);
  const mate = accepted.cookies[0]!.value;
  const boot = (session: string) =>
    call(session, 'GET', '/v1/bootstrap').then((response) => response.json<Bootstrap>());
  const ownerBoot = await boot(owner),
    mateBoot = await boot(mate),
    otherBoot = await boot(other);
  async function channel(visibility: 'public' | 'private' = 'public') {
    const response = await call(owner, 'POST', '/v1/conversations', {
      name: 'chat-' + randomUUID().slice(0, 8),
      visibility,
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }
  const send = (
    session: string,
    channel: string,
    body: string,
    threadId?: string,
    clientId = randomUUID(),
  ) =>
    call(session, 'POST', `/v1/conversations/${channel}/messages`, {
      body,
      clientId,
      ...(threadId ? { threadId } : {}),
    });
  const messages = (session: string, channel: string, threadId?: string) =>
    call(
      session,
      'GET',
      `/v1/conversations/${channel}/messages${threadId ? '?threadId=' + threadId : ''}`,
    ).then((response) => response.json<Message[]>());
  return {
    db,
    app,
    call,
    boot,
    owner,
    mate,
    other,
    ownerBoot,
    mateBoot,
    otherBoot,
    channel,
    send,
    messages,
    async close() {
      await app.close();
      await db.close();
    },
  };
}
