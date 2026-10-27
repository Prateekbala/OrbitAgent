ALTER TABLE email_jobs DROP CONSTRAINT email_jobs_provider_check;
ALTER TABLE email_jobs ADD CONSTRAINT email_jobs_provider_check CHECK(provider IN ('resend','gmail','mailpit'));
