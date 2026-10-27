import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { messagingFixture } from './messaging-fixture.js';
import { publicOperations } from '../src/developer/operations.js';
let f: Awaited<ReturnType<typeof messagingFixture>>;
afterEach(async () => {
  await f?.close();
});
describe('documented public response compatibility', () => {
  it('matches actual task, message, knowledge and event responses to their published contracts', async () => {
    f = await messagingFixture();
    const c = f.ownerBoot.channels[0]!.id,
      key = await f.call(f.owner, 'POST', '/v1/developer/keys', {
        name: 'Contract verification',
        grants: {
          conversationIds: [c],
          scopes: [
            'tasks.read',
            'tasks.write',
            'messages.read',
            'messages.write',
            'knowledge.read',
            'knowledge.write',
            'events.read',
          ],
        },
      });
    expect(key.statusCode, key.body).toBe(201);
    const request = async (operation: string, path: string, body?: unknown) => {
      const op = publicOperations.find((o) => o.id === operation)!;
      const response = await f.app.inject({
        method: op.method,
        url: '/public/v1' + path,
        headers: {
          authorization: 'Bearer ' + key.json().token,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { payload: JSON.stringify(body) } : {}),
      });
      expect(response.statusCode, response.body).toBeLessThan(300);
      const parsed = op.response.safeParse(response.json());
      expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(
        true,
      );
      return response.json();
    };
    const task = await request('createTask', '/tasks', {
      title: 'Typed public task',
      conversationId: c,
      clientId: randomUUID(),
    });
    await request('listTasks', '/tasks');
    await request('getTask', '/tasks/' + task.id);
    await request('updateTask', '/tasks/' + task.id, {
      version: 1,
      title: 'Typed public task revised',
    });
    await request('sendMessage', `/conversations/${c}/messages`, {
      body: 'Typed public message',
      clientId: randomUUID(),
    });
    await request('messageHistory', `/conversations/${c}/messages`);
    const page = await request('createKnowledgePage', '/knowledge', {
      title: 'Typed public page',
      body: 'Reviewed public knowledge.',
      conversationId: c,
    });
    await request('getKnowledgePage', '/knowledge/' + page.id);
    await request('editKnowledgePage', '/knowledge/' + page.id, {
      version: 1,
      title: 'Typed public page revised',
      body: 'A reviewed correction.',
      clientId: randomUUID(),
    });
    await request('events', '/events');
  });
});
