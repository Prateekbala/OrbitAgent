import { z } from 'zod';
import { invitationToken } from './team.js';
export const accountEmail = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
  })
  .strict();
export const accountToken = z.object({ token: invitationToken }).strict();
export const passwordReset = accountToken.extend({ password: z.string().min(12).max(128) });
export interface AccountStatus {
  signedIn: boolean;
  email?: string;
  verified?: boolean;
  deliveryAvailable: boolean;
  developmentInbox?: 'http://localhost:8025';
}
