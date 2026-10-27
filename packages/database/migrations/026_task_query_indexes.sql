CREATE INDEX task_comments_participants ON task_comments(workspace_id,task_id,author_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_source_created ON tasks(workspace_id,conversation_id,created_at DESC,id DESC);
CREATE INDEX tasks_due_order ON tasks(workspace_id,(COALESCE(due_date-date '0001-01-01',2147483647)),created_at DESC,id DESC);
CREATE INDEX tasks_priority_order ON tasks(workspace_id,(CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END),created_at DESC,id DESC);
