import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { format, resolveConfig } from 'prettier';
import openapiTS, { astToString } from 'openapi-typescript';
import { openApi, publicOperations } from '../apps/api/src/developer/operations.js';
const specification = openApi();
const outputs: Record<string, string> = {
  'docs/developer/openapi.json': JSON.stringify(specification, null, 2) + '\n',
  'packages/sdk/src/schema.ts': astToString(
    await openapiTS(Buffer.from(JSON.stringify(specification))),
    { formatOptions: { removeComments: true } },
  ),
  'packages/sdk/src/operations.ts':
    'export const operations = ' +
    JSON.stringify(
      Object.fromEntries(publicOperations.map((o) => [o.id, { method: o.method, path: o.path }])),
      null,
      2,
    ) +
    ' as const;\n',
  'packages/sdk/python/orbit_sdk/operations.py':
    'OPERATIONS = ' +
    JSON.stringify(
      Object.fromEntries(publicOperations.map((o) => [o.id, { method: o.method, path: o.path }])),
      null,
      2,
    ) +
    '\n',
};
const check = process.argv.includes('--check');
for (const [file, raw] of Object.entries(outputs)) {
  const content = /\.(ts|json)$/.test(file)
    ? await format(raw, { ...(await resolveConfig(file)), filepath: file })
    : raw;
  if (check) {
    if ((await readFile(file, 'utf8')) !== content)
      throw new Error('Generated API contract is out of date: ' + file);
  } else {
    await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true });
    await writeFile(file, content);
  }
}
