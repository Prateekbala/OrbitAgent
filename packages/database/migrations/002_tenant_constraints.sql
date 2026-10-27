ALTER TABLE tasks ADD CONSTRAINT tasks_workspace_id_unique UNIQUE(workspace_id,id);
ALTER TABLE task_transitions ADD CONSTRAINT task_transitions_tenant_task_fk FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id);
CREATE INDEX inbox_pending ON agent_inbox(agent_id,state,created_at);
CREATE INDEX knowledge_workspace ON knowledge_pages(workspace_id,updated_at DESC);
CREATE INDEX audit_workspace ON audit_events(workspace_id,created_at DESC);
