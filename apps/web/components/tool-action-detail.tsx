'use client';
import { NativeSelect } from './ui/native-select';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { useEffect, useState } from 'react';
import type { ToolInvocation } from '@ao/contracts';
import { api, post } from '../lib/api';
import { InteractiveForm } from './tool-form';
export const toolLabels: Record<ToolInvocation['tool_name'], string> = {
  create_task: 'Create a task',
  save_knowledge: 'Save a knowledge page',
  delegate_agent: 'Delegate agent work',
  read_tasks: 'Read scoped tasks',
  read_knowledge: 'Read scoped knowledge',
  connection_action: 'Perform provider operation',
  execute_code: 'Run isolated code',
  interactive_form: 'Publish interactive form',
};
export function ToolActionDetail({
  action,
  canReconcile = false,
}: {
  action: ToolInvocation;
  canReconcile?: boolean;
}) {
  const [ledger, setLedger] = useState<Record<string, unknown> | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    if (
      !['connection_action', 'execute_code'].includes(action.tool_name) ||
      action.status === 'pending'
    )
      return;
    const controller = new AbortController();
    void api<Record<string, unknown>>(`/execution/actions/${action.id}`, {
      signal: controller.signal,
    })
      .then(setLedger)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [action.id, action.status, action.tool_name]);
  const context = action.authorization_snapshot;
  return (
    <div>
      {context && (
        <p>
          <strong>Effect:</strong> {String(context.effect)}
          {context.connectionName ? ' · Account: ' + String(context.connectionName) : ''}
          {context.destination ? ' · Destination: ' + String(context.destination) : ''}
          {context.resource ? ' · Resource: ' + String(context.resource) : ''}
        </p>
      )}
      {Boolean(context?.operationDescription) && <p>{String(context?.operationDescription)}</p>}
      {!['create_task', 'save_knowledge', 'delegate_agent'].includes(action.tool_name) && (
        <pre className="tool-parameters">{JSON.stringify(action.parameters, null, 2)}</pre>
      )}
      {['read_tasks', 'read_knowledge'].includes(action.tool_name) && action.result && (
        <details>
          <summary>Authorized tool result</summary>
          <pre className="tool-parameters">{JSON.stringify(action.result, null, 2)}</pre>
        </details>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {canReconcile && ledger?.state === 'outcome_unknown' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = new FormData(e.currentTarget);
            void post(`/execution/actions/${action.id}/reconcile`, {
              outcome: v.get('outcome'),
              receipt: v.get('receipt'),
              evidence: v.get('evidence'),
            })
              .then(() => api<Record<string, unknown>>(`/execution/actions/${action.id}`))
              .then(setLedger)
              .catch((e) => setError(e.message));
          }}
        >
          <label>
            Confirmed outcome
            <NativeSelect name="outcome">
              <option value="succeeded">Provider confirms success</option>
              <option value="not_applied">Provider confirms not applied</option>
            </NativeSelect>
          </label>
          <label>
            Provider receipt
            <Input name="receipt" required minLength={5} maxLength={500} />
          </label>
          <label>
            Independent reconciliation evidence
            <Textarea name="evidence" required minLength={20} maxLength={2000} />
          </label>
          <p className="muted">
            Confirm the provider result before attesting. This records the result without replaying
            the action.
          </p>
          <Button variant="outline">Record confirmed action outcome</Button>
        </form>
      )}
      {ledger && (
        <details>
          <summary>Action ledger · {String(ledger.state)}</summary>
          <pre className="tool-parameters">{JSON.stringify(ledger, null, 2)}</pre>
        </details>
      )}
      {action.tool_name === 'interactive_form' &&
        action.status === 'succeeded' &&
        typeof action.result?.resourceId === 'string' && (
          <InteractiveForm formId={action.result.resourceId} />
        )}
    </div>
  );
}
