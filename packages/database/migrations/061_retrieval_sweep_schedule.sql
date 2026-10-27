ALTER TABLE retrieval_authority ADD COLUMN next_orphan_sweep timestamptz NOT NULL DEFAULT now();
