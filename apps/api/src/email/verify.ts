import { configuredEmail } from './service.js';
import { GmailProvider } from './gmail.js';
import { MailpitProvider } from './mailpit.js';
import { DeliveryError } from './provider.js';
try {
  if (process.env.EMAIL_PROVIDER === 'gmail') {
    const missing = ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'EMAIL_ENCRYPTION_KEY'].filter(
      (name) => !process.env[name]?.trim(),
    );
    if (missing.length)
      throw new Error(
        `Set ${missing.join(', ')} in the server environment or local .env file, then rerun npm run email:verify.`,
      );
  }
  const email = configuredEmail(process.env, process.env.WEB_ORIGIN ?? 'http://localhost:3000');
  email.requireConfigured();
  if (!(email.provider instanceof GmailProvider || email.provider instanceof MailpitProvider))
    throw new Error('This command checks SMTP; select EMAIL_PROVIDER=gmail or mailpit.');
  await email.provider.verify();
  console.log(
    email.provider.id === 'mailpit'
      ? 'Local inbox SMTP is reachable. Open http://localhost:8025. No email was sent.'
      : 'Gmail SMTP authentication verified. No email was sent.',
  );
} catch (error) {
  console.error(
    error instanceof DeliveryError
      ? error.code
      : error instanceof Error
        ? error.message
        : 'Email configuration verification failed.',
  );
  process.exitCode = 1;
}
