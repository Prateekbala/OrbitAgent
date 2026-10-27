import { randomUUID } from 'node:crypto';
import { OrbitClient } from '../../packages/sdk/src/index.js';
const token = process.env.ORBIT_API_KEY;
const conversation = process.env.ORBIT_CONVERSATION_ID;
if (!token || !conversation)
  throw new Error('Set ORBIT_API_KEY and ORBIT_CONVERSATION_ID in your local secret environment.');
const client = new OrbitClient(
  process.env.ORBIT_API_URL ?? 'http://localhost:3000/api/public/v1',
  () => token,
);
const clientId = randomUUID();
const created = await client.request('createTask', {
  body: { clientId, title: 'Review integration contract', conversationId: conversation },
});
process.stdout.write(JSON.stringify({ id: created.id }) + '\n');
const task = await client.request('getTask', { path: { id: created.id } });
process.stdout.write(JSON.stringify(task) + '\n');
