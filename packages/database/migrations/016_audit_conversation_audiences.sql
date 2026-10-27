ALTER TABLE audit_events ADD COLUMN conversation_id uuid;
ALTER TABLE audit_events ADD COLUMN audience_membership_id uuid;
ALTER TABLE audit_events ADD CONSTRAINT audit_conversation FOREIGN KEY(workspace_id,conversation_id) REFERENCES conversations(workspace_id,id);
ALTER TABLE audit_events ADD CONSTRAINT audit_audience FOREIGN KEY(workspace_id,audience_membership_id) REFERENCES memberships(workspace_id,id);
UPDATE audit_events a SET conversation_id=e.conversation_id,audience_membership_id=e.audience_membership_id
 FROM outbox_events e WHERE a.workspace_id=e.workspace_id AND a.resource_id=e.resource_id AND a.action=e.event_type AND a.created_at=e.created_at;
