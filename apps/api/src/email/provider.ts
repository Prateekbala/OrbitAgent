import { z } from 'zod';
export const emailMessage = z
  .object({
    from: z
      .string()
      .min(3)
      .max(320)
      .regex(/^[^\r\n]+$/),
    to: z.array(z.email()).length(1),
    subject: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\r\n]+$/),
    text: z.string().max(20000),
    html: z.string().max(40000),
  })
  .strict();
export type EmailMessage = z.infer<typeof emailMessage>;
export interface EmailProvider {
  readonly id: 'resend' | 'gmail' | 'mailpit';
  readonly idempotent: boolean;
  send(message: EmailMessage, idempotencyKey: string): Promise<string>;
}
export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly uncertain = false,
  ) {
    super(code);
  }
}
export class ResendProvider implements EmailProvider {
  readonly id = 'resend';
  readonly idempotent = true;
  constructor(
    private readonly key: string,
    private readonly request: typeof fetch = fetch,
  ) {}
  async send(message: EmailMessage, idempotencyKey: string) {
    const body = JSON.stringify(emailMessage.parse(message));
    let response: Response;
    try {
      response = await this.request('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: `Bearer ${this.key}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body,
      });
    } catch {
      throw new DeliveryError('EMAIL_TRANSPORT_UNCERTAIN', true);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new DeliveryError(
        `EMAIL_PROVIDER_${response.status}`,
        response.status === 429 || response.status === 409 || response.status >= 500,
      );
    }
    const data = z
      .object({ id: z.string().min(1).max(200) })
      .safeParse(await response.json().catch(() => null));
    if (!data.success) throw new DeliveryError('EMAIL_RESPONSE_UNCERTAIN', true);
    return data.data.id;
  }
}
