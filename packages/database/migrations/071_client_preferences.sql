ALTER TABLE accounts ADD COLUMN onboarding_version integer NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN onboarding_steps text[] NOT NULL DEFAULT '{}';
ALTER TABLE accounts ADD COLUMN onboarding_dismissed boolean NOT NULL DEFAULT false;
