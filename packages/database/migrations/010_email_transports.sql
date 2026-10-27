ALTER TABLE email_jobs ADD COLUMN provider text NOT NULL DEFAULT 'resend' CHECK(provider IN ('resend','gmail'));
ALTER TABLE email_jobs ADD COLUMN idempotent boolean NOT NULL DEFAULT true;
ALTER TABLE email_jobs ADD CONSTRAINT email_jobs_transport_policy CHECK((provider='resend')=idempotent);
ALTER TABLE email_jobs DROP CONSTRAINT email_jobs_status_check;
ALTER TABLE email_jobs ADD CONSTRAINT email_jobs_status_check CHECK(status IN ('queued','sending','sent','failed','cancelled','outcome_unknown'));
CREATE INDEX email_jobs_provider_ready ON email_jobs(provider,available_at) WHERE status IN ('queued','sending');
