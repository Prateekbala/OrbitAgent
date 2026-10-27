import { Worker } from 'node:worker_threads';
import { AppError } from '../lib/errors.js';
export function validateRemoteInput(
  schema: Record<string, unknown>,
  value: unknown,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `
      const { parentPort,workerData } = require('node:worker_threads');
      import('@modelcontextprotocol/client/validators/ajv').then(({AjvJsonSchemaValidator})=>{
        try { parentPort.postMessage(Boolean(new AjvJsonSchemaValidator().getValidator(workerData.schema)(workerData.value).valid)); }
        catch { parentPort.postMessage(false); }
      }).catch(()=>parentPort.postMessage(false));
    `,
      {
        eval: true,
        execArgv: [],
        workerData: { schema, value },
        resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
      },
    );
    let settled = false;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (valid) resolve();
      else
        reject(
          new AppError(
            400,
            'MCP_INPUT_INVALID',
            'Arguments must match a bounded, valid reviewed remote tool schema.',
          ),
        );
    };
    const timer = setTimeout(() => finish(false), 1000);
    timer.unref();
    worker.once('message', (valid: unknown) => finish(valid === true));
    worker.once('error', () => finish(false));
    worker.once('exit', () => finish(false));
  });
}
