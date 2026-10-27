ALTER TABLE task_recurrences ADD COLUMN lead_days integer NOT NULL DEFAULT 0 CHECK(lead_days BETWEEN 0 AND 365);
