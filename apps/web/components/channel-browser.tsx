'use client';
import { WorkspaceHeading } from './workspace-heading';
import { Hash } from 'lucide-react';
import { Input } from './ui/input';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { NativeSelect } from './ui/native-select';
import { useState } from 'react';
import type { Bootstrap } from '@ao/contracts';
import { api } from '../lib/api';
import { useCursorPage } from '../lib/use-cursor-page';
import { PageControls } from './page-controls';
interface DiscoveredChannel {
  id: string;
  name: string;
  description: string;
  visibility: string;
  joined: boolean;
  version: number;
  archived_at: string | null;
  history_policy: 'retained' | 'join_time';
}
export function ChannelBrowser({
  boot,
  revision,
  onOpen,
  onChanged,
}: {
  boot: Bootstrap;
  revision: number;
  onOpen: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [query, setQuery] = useState(''),
    [archived, setArchived] = useState(false),
    [editing, setEditing] = useState<DiscoveredChannel | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const page = useCursorPage<DiscoveredChannel>(
      `${boot.workspace.id}:${boot.me.id}`,
      '/channels/discover?' + new URLSearchParams({ q: query, archived: String(archived) }),
      revision,
    ),
    canManage = boot.me.kind === 'human' && ['owner', 'admin'].includes(boot.me.role);
  async function mutate(item: DiscoveredChannel, change: unknown) {
    setBusy(true);
    setError('');
    try {
      await api(`/conversations/${item.id}/channel`, {
        method: 'PATCH',
        body: JSON.stringify({ version: item.version, ...(change as object) }),
      });
      setEditing(null);
      await Promise.all([page.refresh(), onChanged()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update channel.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="page-content">
      <WorkspaceHeading
        icon={Hash}
        eyebrow="Find your people"
        title="Discover channels"
        description="Explore public channels and conversations already shared with you."
      />
      <div className="channel-filters">
        <label>
          Find channels
          <Input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label>
          <Input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Show archived channels
        </label>
      </div>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {page.items.map((item) => (
        <Card key={item.id} asChild>
          <article className="personal-message-card">
            <h3>
              {item.visibility === 'private' ? 'Private · ' : ''}
              {item.name}
            </h3>
            <p>{item.description}</p>
            <p className="muted">
              {item.history_policy === 'join_time'
                ? 'New members see messages from when they join.'
                : 'Members can read retained history.'}
            </p>
            <Button variant="outline" onClick={() => onOpen(item.id)}>
              Open channel
            </Button>
            {!item.archived_at && boot.me.access_type !== 'guest' ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void api(`/conversations/${item.id}/join`, {
                    method: item.joined ? 'DELETE' : 'PUT',
                  })
                    .then(() => Promise.all([page.refresh(), onChanged()]))
                    .catch((e) =>
                      setError(e instanceof Error ? e.message : 'Unable to join channel.'),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {item.joined ? 'Leave channel' : 'Join channel'}
              </Button>
            ) : null}
            {canManage ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void mutate(item, { archived: !item.archived_at })}
                >
                  {item.archived_at ? 'Restore channel' : 'Archive channel'}
                </Button>
                <Button variant="outline" onClick={() => setEditing(item)}>
                  Manage channel
                </Button>
              </>
            ) : null}
            {editing?.id === item.id ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const f = new FormData(event.currentTarget);
                  void mutate(item, {
                    name: f.get('name'),
                    description: f.get('description'),
                    historyPolicy: f.get('history'),
                  });
                }}
              >
                <label>
                  Channel name
                  <Input
                    name="name"
                    defaultValue={item.name}
                    required
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    maxLength={64}
                  />
                </label>
                <label>
                  Description
                  <Textarea name="description" defaultValue={item.description} maxLength={300} />
                </label>
                <label>
                  History for future joins
                  <NativeSelect name="history" defaultValue={item.history_policy}>
                    <option value="retained">Retained history</option>
                    <option value="join_time">From join time</option>
                  </NativeSelect>
                </label>
                <p>
                  Changing this policy applies to future joins. It does not expand existing members’
                  history grants.
                </p>
                <Button variant="outline" disabled={busy}>
                  Save channel
                </Button>
                <Button variant="outline" type="button" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </form>
            ) : null}
          </article>
        </Card>
      ))}
      <PageControls {...page} onMore={page.more} />
    </section>
  );
}
