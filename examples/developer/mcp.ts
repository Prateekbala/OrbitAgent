import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const token = process.env.ORBIT_API_KEY;
if (!token) throw new Error('Set an MCP-scoped ORBIT_API_KEY in your secret environment.');
const client = new Client({ name: 'Orbit external client example', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(
  new URL(process.env.ORBIT_MCP_URL ?? 'http://localhost:3000/api/mcp'),
  { requestInit: { headers: { authorization: 'Bearer ' + token }, redirect: 'error' } },
);
try {
  await client.connect(transport);
  const tools = await client.listTools();
  process.stdout.write(
    JSON.stringify(tools.tools.map((t) => ({ name: t.name, description: t.description }))) + '\n',
  );
} finally {
  await client.close();
}
