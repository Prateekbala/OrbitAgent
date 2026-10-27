'use client';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { knowledgeKinds } from '@ao/contracts/knowledge';
import { useState } from 'react';
import { TaskOrganizationFields, emptyOrganization } from './task-organization';
import { ArrowUpRight } from 'lucide-react';
import type { Member, Channel } from '@ao/contracts';
import { Dialog } from './dialog';
export type CreateKind = 'channel' | 'task' | 'agent' | 'page';
export function CreateDialog({
  dialog,
  members,
  channels,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  dialog: CreateKind;
  members: Member[];
  channels: Channel[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
}) {
  const [source, setSource] = useState('');
  const [organization, setOrganization] = useState(emptyOrganization);
  return (
    <Dialog
      title={
        dialog === 'channel'
          ? 'Create a channel'
          : dialog === 'task'
            ? 'Create a task'
            : dialog === 'agent'
              ? 'Introduce an agent'
              : 'Write a knowledge page'
      }
      onClose={() => onClose()}
    >
      <form onSubmit={onSubmit}>
        {dialog === 'channel' && (
          <>
            <label>
              Channel name
              <Input
                name="name"
                placeholder="project-launch"
                required
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                minLength={2}
                maxLength={64}
              />
            </label>
            <label>
              Description
              <Input name="description" maxLength={300} />
            </label>
            <label>
              Visibility
              <NativeSelect name="visibility" aria-label="Visibility">
                <option value="public">Public — workspace members</option>
                <option value="private">Private — invited members only</option>
              </NativeSelect>
            </label>
          </>
        )}
        {dialog === 'task' && (
          <>
            <label>
              Task audience
              <NativeSelect
                name="conversationId"
                aria-label="Task audience"
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setOrganization({ ...emptyOrganization, labels: organization.labels });
                }}
              >
                <option value="">Entire workspace</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name}
                    {channel.visibility === 'private' ? ' · Private' : ''}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <TaskOrganizationFields
              source={source || null}
              value={organization}
              onChange={setOrganization}
              disabled={busy}
            />
            <Input type="hidden" name="projectId" value={organization.projectId} />
            <Input type="hidden" name="milestoneId" value={organization.milestoneId} />
            <Input
              type="hidden"
              name="labelIds"
              value={JSON.stringify(organization.labels.map((l) => l.id))}
            />
            <label>
              Due date
              <Input
                name="dueDate"
                aria-label="Task due date"
                type="date"
                min="0001-01-01"
                max="9999-12-31"
              />
            </label>

            <label>
              Task title
              <Input name="title" required minLength={3} maxLength={200} />
            </label>
            <label>
              Description
              <Textarea name="description" aria-label="Description" maxLength={12000} rows={4} />
            </label>
            <label>
              Assignee
              <NativeSelect name="assigneeId" aria-label="Assignee">
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              Priority
              <NativeSelect name="priority" aria-label="Priority" defaultValue="normal">
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </NativeSelect>
            </label>
          </>
        )}
        {dialog === 'agent' && (
          <>
            <p className="muted">
              Choose hosted execution or connect an agent you run. External credentials are shown
              once.
            </p>
            <label>
              Name
              <Input name="name" required minLength={2} maxLength={80} placeholder="e.g. Atlas" />
            </label>
            <label>
              Execution
              <NativeSelect name="runtime" aria-label="Execution" defaultValue="external">
                <option value="external">External — I run the agent</option>
                <option value="managed">Hosted — platform runs the agent</option>
              </NativeSelect>
            </label>
            <label>
              Role and instructions
              <Textarea
                name="role"
                required
                minLength={3}
                maxLength={1000}
                rows={4}
                placeholder="What should this teammate help with?"
              />
            </label>
          </>
        )}
        {dialog === 'page' && (
          <>
            <label>
              Knowledge type
              <NativeSelect name="kind" defaultValue="page">
                {knowledgeKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind.replace('_', ' ')}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label>
              Page audience
              <NativeSelect name="conversationId" aria-label="Page audience">
                <option value="">Entire workspace</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name} ·{' '}
                    {channel.visibility === 'private'
                      ? 'Conversation members only'
                      : 'Workspace members'}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <p className="muted">
              The page and every version retain this audience. Private source material belongs in a
              page scoped to its conversation.
            </p>
            <label>
              Title
              <Input name="title" required minLength={2} maxLength={200} />
            </label>
            <label>
              Content
              <Textarea name="body" required rows={10} maxLength={50000} />
            </label>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Button className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Create'}
          <ArrowUpRight size={16} />
        </Button>
      </form>
    </Dialog>
  );
}
