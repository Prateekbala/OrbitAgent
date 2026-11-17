import type { BackgroundDispatcher } from '../src/background/dispatcher.js';
import type { BackgroundMessage, BackgroundPublisher } from '../src/background/queue.js';

export class TestBackgroundQueue implements BackgroundPublisher {
  dispatcher!: BackgroundDispatcher;
  readonly errors: unknown[] = [];
  readonly deliveries: BackgroundMessage[] = [];
  private readonly seen = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly pending = new Set<Promise<void>>();
  private closed = false;

  async publish(message: BackgroundMessage, delaySeconds: number) {
    const key = `${message.worker}/${message.generation}`;
    if (this.closed || this.seen.has(key)) return;
    this.seen.add(key);
    this.deliveries.push(message);
    if (delaySeconds > 30) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        const operation = this.dispatcher.run(message).catch((error: unknown) => {
          this.errors.push(error);
        });
        this.pending.add(operation);
        void operation.finally(() => this.pending.delete(operation));
      },
      Math.max(10, delaySeconds * 1000),
    );
    timer.unref();
    this.timers.add(timer);
  }

  async close() {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    await Promise.all(this.pending);
  }
}
