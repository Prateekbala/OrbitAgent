import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
const summary = z.object({
  ID: z.string().min(1),
  Subject: z.string(),
  To: z.array(z.object({ Address: z.string() })),
});
const detail = summary.extend({ Text: z.string() });

export class LocalMailbox {
  private readonly owned = new Set<string>();
  private async request(path: string, options: RequestInit = {}) {
    const response = await fetch('http://127.0.0.1:8025/api/v1/' + path, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(`Local inbox returned HTTP ${response.status}; run npm run email:dev.`);
    return response;
  }
  async read(address: string, subject: string) {
    const query = 'search?query=' + encodeURIComponent('to:' + z.email().parse(address));
    for (let attempt = 0; attempt < 20; attempt++) {
      const list = z
        .object({ messages: z.array(summary) })
        .parse(await (await this.request(query)).json());
      for (const item of list.messages) {
        if (!item.To.some((value) => value.Address === address)) continue;
        this.owned.add(item.ID);
        if (item.Subject !== subject) continue;
        return detail.parse(
          await (await this.request('message/' + encodeURIComponent(item.ID))).json(),
        );
      }
      await setTimeout(100);
    }
    throw new Error('Expected local email was not captured.');
  }
  async cleanup() {
    if (!this.owned.size) return;
    await this.request('messages', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ IDs: [...this.owned] }),
    });
    this.owned.clear();
  }
}
