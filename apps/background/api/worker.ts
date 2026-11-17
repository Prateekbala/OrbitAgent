import { QueueClient } from '@vercel/queue';
import { serverlessBackground } from '@ao/api/background';

const queue = new QueueClient();
export default queue.handleNodeCallback<{
  version: 1;
  worker: string;
  generation: string;
}>(
  async (message) => {
    await (await serverlessBackground()).run(message);
  },
  {
    visibilityTimeoutSeconds: 300,
    retry: (_error, metadata) => ({
      afterSeconds: Math.min(900, 15 * 2 ** Math.min(metadata.deliveryCount - 1, 6)),
    }),
  },
);
