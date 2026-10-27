'use client';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { useEffect, useState } from 'react';
import type { Member } from '@ao/contracts';
import type { BusinessCalendar } from '@ao/contracts/workflows';
import { api } from '../lib/api';
import { useCursorPage } from '../lib/use-cursor-page';
import { PageControls } from './page-controls';
interface Connection {
  id: string;
  provider: string;
  status: string;
  version: number;
  last_synced_at: string | null;
  error_code: string | null;
}
interface Conflict {
  id: string;
  connection_id: string;
  title: string;
  version: number;
  due_date: string | null;
  remote: { date: string | null; summary: string; status: string } | null;
}
export function CalendarSettings({
  me,
  revision,
  onChanged,
}: {
  me: Member;
  revision: number;
  onChanged: () => Promise<unknown>;
}) {
  const calendars = useCursorPage<BusinessCalendar>(me.id, '/business-calendars', revision),
    feeds = useCursorPage<{ id: string; expires_at: string; revoked_at: string | null }>(
      me.id,
      '/calendar/feeds',
      revision,
    ),
    conflicts = useCursorPage<Conflict>(me.id, '/calendar/conflicts', revision);
  const [connections, setConnections] = useState<Connection[]>([]),
    [configured, setConfigured] = useState(false),
    [editing, setEditing] = useState<BusinessCalendar | 'new' | null>(null),
    [feedUrl, setFeedUrl] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const request = new AbortController();
    void api<{ configured: boolean; items: Connection[] }>('/calendar/connections', {
      signal: request.signal,
    })
      .then((value) => {
        if (!request.signal.aborted) {
          setConnections(value.items);
          setConfigured(value.configured);
        }
      })
      .catch((error) => {
        if (!request.signal.aborted) {
          setConnections([]);
          setError(error instanceof Error ? error.message : 'Unable to load calendar connections.');
        }
      });
    return () => request.abort();
  }, [revision]);
  async function act(path: string, body?: unknown, method = 'POST') {
    if (busy) return false;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ url?: string }>(path, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (result.url) {
        if (path.endsWith('/connect')) window.location.assign(result.url);
        else setFeedUrl(result.url);
      }
      await onChanged();
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to update calendar settings.');
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="work-hub" aria-label="Calendar connections and business days">
      <h3>Calendar connections</h3>
      <p className="muted">
        Sync your assigned workspace tasks to your primary Google calendar, or subscribe through an
        expiring iCalendar link. Conversation-scoped tasks are excluded to protect private
        discussions. Disconnecting stops sync; exported events already in your calendar remain yours
        to remove.
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <Button
        variant="outline"
        disabled={busy || !configured}
        onClick={() => void act('/calendar/google/connect')}
      >
        Connect Google Calendar
      </Button>
      {!configured ? (
        <p className="muted">
          Google Calendar connection is unavailable until the operator configures OAuth credentials.
        </p>
      ) : null}
      {connections.map((connection) => (
        <Card key={connection.id} asChild>
          <article className="work-card">
            <strong>Google Calendar · {connection.status}</strong>
            <p>
              {connection.last_synced_at
                ? 'Last synchronized ' + new Date(connection.last_synced_at).toLocaleString()
                : 'Not synchronized yet'}
            </p>
            {connection.error_code ? <p>{connection.error_code}</p> : null}
            <div className="work-actions">
              <Button
                variant="outline"
                disabled={busy || connection.status !== 'active'}
                onClick={() => void act(`/calendar/connections/${connection.id}/sync`)}
              >
                Sync calendar now
              </Button>
              <Button
                variant="outline"
                disabled={busy || connection.status === 'disconnected'}
                onClick={() =>
                  void act(
                    `/calendar/connections/${connection.id}`,
                    { version: connection.version },
                    'DELETE',
                  )
                }
              >
                Disconnect calendar
              </Button>
            </div>
          </article>
        </Card>
      ))}
      <h4>Calendar conflicts</h4>
      <p className="muted">
        External edits are kept for review rather than silently overwriting task dates.
      </p>
      {conflicts.items.map((conflict) => (
        <Card key={conflict.id} asChild>
          <article className="work-card">
            <strong>{conflict.title}</strong>
            <p>
              Task due {conflict.due_date ?? 'not set'} · Calendar{' '}
              {conflict.remote?.status === 'cancelled'
                ? 'event removed'
                : (conflict.remote?.date ?? 'changed; sync to retrieve details')}
            </p>
            <div className="work-actions">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act('/calendar/conflicts/' + conflict.id, {
                    connectionId: conflict.connection_id,
                    version: conflict.version,
                    resolution: 'local',
                  })
                }
              >
                Keep task date
              </Button>
              <Button
                variant="outline"
                disabled={busy || !conflict.remote?.date || conflict.remote.status === 'cancelled'}
                onClick={() =>
                  void act('/calendar/conflicts/' + conflict.id, {
                    connectionId: conflict.connection_id,
                    version: conflict.version,
                    resolution: 'remote',
                  })
                }
              >
                Use calendar date
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act('/calendar/conflicts/' + conflict.id, {
                    connectionId: conflict.connection_id,
                    version: conflict.version,
                    resolution: 'unlink',
                  })
                }
              >
                Stop syncing this event
              </Button>
            </div>
          </article>
        </Card>
      ))}
      <PageControls {...conflicts} onMore={conflicts.more} />
      <h4>iCalendar subscriptions</h4>
      <Button variant="outline" disabled={busy} onClick={() => void act('/calendar/feeds')}>
        Create private calendar subscription
      </Button>
      {feedUrl ? (
        <label>
          Private subscription URL
          <Input readOnly value={feedUrl} onFocus={(event) => event.target.select()} />
          <small>
            Anyone with this URL can read the feed until it expires or you revoke it. Save it now;
            the secret is shown only once.
          </small>
        </label>
      ) : null}
      {feeds.items.map((feed) => (
        <article className="work-inline" key={feed.id}>
          <span>
            {feed.revoked_at
              ? 'Revoked'
              : 'Expires ' + new Date(feed.expires_at).toLocaleDateString()}
          </span>
          <Button
            variant="outline"
            disabled={busy || Boolean(feed.revoked_at)}
            onClick={() => void act('/calendar/feeds/' + feed.id, undefined, 'DELETE')}
          >
            Revoke calendar subscription
          </Button>
        </article>
      ))}
      <PageControls {...feeds} onMore={feeds.more} />
      <h3>Business calendars</h3>
      <p className="muted">
        Configure working weekdays and holidays. Existing recurring schedules retain their captured
        calendar until reviewed and saved again.
      </p>
      {calendars.items.map((calendar) => (
        <Card key={calendar.id} asChild>
          <article className="work-card">
            <strong>{calendar.name}</strong>
            <p>
              {calendar.time_zone} ·{' '}
              {calendar.weekdays
                .map((d) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d])
                .join(', ')}{' '}
              · {calendar.holidays.length} holidays · revision {calendar.version}
            </p>
            {['owner', 'admin'].includes(me.role) ? (
              <Button variant="outline" onClick={() => setEditing(calendar)}>
                Edit business calendar
              </Button>
            ) : null}
          </article>
        </Card>
      ))}
      <PageControls {...calendars} onMore={calendars.more} />
      {['owner', 'admin'].includes(me.role) ? (
        <Button variant="outline" onClick={() => setEditing('new')}>
          New business calendar
        </Button>
      ) : null}
      {editing ? (
        <BusinessCalendarForm
          key={editing === 'new' ? 'new' : editing.id}
          value={editing === 'new' ? null : editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={async (id, body) => {
            if (await act('/business-calendars/' + id, body, 'PUT')) setEditing(null);
          }}
        />
      ) : null}
    </section>
  );
}
function BusinessCalendarForm({
  value,
  busy,
  onCancel,
  onSave,
}: {
  value: BusinessCalendar | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (id: string, body: unknown) => Promise<void>;
}) {
  const [key] = useState(() => value?.id ?? crypto.randomUUID()),
    [weekdays, setWeekdays] = useState(value?.weekdays ?? [1, 2, 3, 4, 5]);
  return (
    <Card asChild>
      <form
        className="work-card work-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void onSave(key, {
            version: value?.version ?? 0,
            name: data.get('name'),
            timeZone: data.get('zone'),
            weekdays,
            holidays: String(data.get('holidays')).split(/\s+/).filter(Boolean),
          });
        }}
      >
        <label>
          Business calendar name
          <Input
            name="name"
            required
            minLength={2}
            maxLength={160}
            defaultValue={value?.name ?? ''}
          />
        </label>
        <label>
          Business calendar time zone
          <Input
            name="zone"
            required
            defaultValue={value?.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
          />
        </label>
        <fieldset>
          <legend>Working weekdays</legend>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, index) => (
            <label className="checkbox-label" key={label}>
              <Input
                type="checkbox"
                checked={weekdays.includes(index + 1)}
                onChange={(event) =>
                  setWeekdays((v) =>
                    event.target.checked
                      ? [...v, index + 1].sort()
                      : v.filter((d) => d !== index + 1),
                  )
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
        <label>
          Holidays, one date per line
          <Textarea
            name="holidays"
            defaultValue={value?.holidays.join('\n') ?? ''}
            placeholder="2030-01-01"
          />
        </label>
        <Button variant="outline" disabled={busy || !weekdays.length}>
          Save business calendar
        </Button>
        <Button variant="outline" type="button" onClick={onCancel}>
          Cancel calendar edit
        </Button>
      </form>
    </Card>
  );
}
