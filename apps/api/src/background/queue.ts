import { QueueClient } from '@vercel/queue';
import { Agent } from 'undici';

const backgroundTopic = 'orbit-background-v1';
export interface BackgroundMessage {
  version: 1;
  worker: string;
  generation: string;
}
export interface BackgroundPublisher {
  publish(message: BackgroundMessage, delaySeconds: number): Promise<void>;
}

export function vercelBackgroundQueue(): BackgroundPublisher {
  const queue = new QueueClient({
    deploymentId: null,
    dispatcher: new Agent({ headersTimeout: 10000, bodyTimeout: 10000 }),
  });
  return {
    async publish(message, delaySeconds) {
      await queue.send(backgroundTopic, message, {
        delaySeconds,
        retentionSeconds: 604800,
        idempotencyKey: `${message.worker}/${message.generation}`,
      });
    },
  };
}
