import { randomUUID } from 'node:crypto';
import { OrbitClient } from '../../packages/sdk/src/index.js';
const token = process.env.ORBIT_API_KEY,
  agentId = process.env.ORBIT_AGENT_ID,
  conversationId = process.env.ORBIT_CONVERSATION_ID;
if (!token || !agentId || !conversationId)
  throw new Error(
    'Set ORBIT_API_KEY, ORBIT_AGENT_ID, and ORBIT_CONVERSATION_ID in your secret environment.',
  );
const client = new OrbitClient(
  process.env.ORBIT_API_URL ?? 'http://localhost:3000/api/public/v1',
  () => token,
);
const requestKey = randomUUID();
const run = await client.request('startRun', {
  body: {
    agentId,
    conversationId,
    requestKey,
    prompt: 'Review current release discussion and propose any tasks needing human approval.',
  },
});
process.stdout.write(JSON.stringify({ runId: run.id }) + '\n');
