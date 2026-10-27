'use client';
import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';
import { governancePolicy } from '@ao/contracts/governance';
import { api, post } from '../lib/api';
import { Card } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
type Policy = z.infer<typeof governancePolicy>;
interface Audit {
  sequence: string;
  action: string;
  resource_id: string | null;
  occurred_at: string;
  hash: string;
}
interface Hold {
  id: string;
  workspace_id: string;
  reason: string;
  reference: string;
  released_at: string | null;
}
interface Grant {
  id: string;
  purpose: string;
  ticket: string;
  expires_at: string;
  revoked_at: string | null;
}
interface QueueRow {
  state: string;
  total: number;
  oldest: string;
}
interface Job {
  id: string;
  kind: string;
  state: string;
  source_id: string;
  receipt_after: string;
}
export function GovernanceSettings({
  organizationId,
  owner,
}: {
  organizationId: string;
  owner: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card asChild>
      <details className="settings-card" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>Enterprise governance & operations</summary>
        {open && <GovernancePanel organizationId={organizationId} owner={owner} />}
      </details>
    </Card>
  );
}
function GovernancePanel({ organizationId, owner }: { organizationId: string; owner: boolean }) {
  const path = `/organizations/${organizationId}/governance`;
  const [releaseReasons, setReleaseReasons] = useState<Record<string, string>>({});
  const [queues, setQueues] = useState<Record<string, QueueRow[]>>();
  const [policy, setPolicy] = useState<Policy>(),
    [audit, setAudit] = useState<Audit[]>([]),
    [next, setNext] = useState<string | null>(null),
    [query, setQuery] = useState(''),
    [holds, setHolds] = useState<Hold[]>([]),
    [grants, setGrants] = useState<Grant[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const options = signal ? { signal } : {};
      const [p, h, g, j, w] = await Promise.all([
        api<Policy>(path, options),
        api<Hold[]>(path + '/holds', options),
        api<Grant[]>(path + '/support', options),
        api<Job[]>(path + '/erasures', options),
        api<{ id: string; name: string }[]>(`/organizations/${organizationId}/workspaces`, options),
      ]);
      setPolicy(p);
      setHolds(h);
      setGrants(g);
      setJobs(j);
      setWorkspaces(w);
    },
    [path, organizationId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((e) => {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Unable to load governance.');
    });
    return () => controller.abort();
  }, [refresh]);
  async function perform(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed.');
    } finally {
      setBusy(false);
    }
  }
  function csv(value: FormDataEntryValue | null) {
    return String(value ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  }
  const labels = {
    hostedExecution: 'Hosted agent execution',
    agentCreation: 'Agent creation',
    connections: 'External connections',
    internalSharing: 'Recipient sharing links',
    externalSharing: 'Cross-organization channels',
    voiceAgents: 'Live voice agents',
    exports: 'Workspace and organization exports',
    supportAccess: 'Purpose-recorded support diagnostics',
    attestedEgress: 'Require approved provider-region attestations',
    analytics: 'Aggregate product analytics',
  } as const;
  return (
    <section className="commercial-panel governance-panel" aria-label="Enterprise governance">
      <h3>Organization controls</h3>
      <p className="muted">
        Policies apply across workspaces and invalidate earlier authority. Owners approve policy
        changes; support grants provide diagnostics without private-content access.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {policy && (
        <form
          key={policy.version}
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void perform(async () => {
              const updated = {
                ...policy,
                ...Object.fromEntries(Object.keys(labels).map((key) => [key, data.has(key)])),
                models: csv(data.get('models')),
                tools: csv(data.get('tools')),
                connectionProviders: csv(data.get('providers')),
                byok: data.get('byok'),
                recordingModes: data.getAll('recordingModes'),
                retentionDays: String(data.get('retention')).trim()
                  ? Number(data.get('retention'))
                  : null,
                backupMaxDays: Number(data.get('backup')),
              };
              await api(path, { method: 'PUT', body: JSON.stringify(updated) });
              setMessage(
                'Governance policy saved. Earlier grants and execution contexts must be revalidated.',
              );
            });
          }}
        >
          <fieldset disabled={!owner || busy}>
            <legend>Policy revision {policy.version}</legend>
            <div className="governance-options">
              {Object.entries(labels).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    name={key}
                    defaultChecked={policy[key as keyof typeof labels]}
                  />
                  {label}
                </label>
              ))}
            </div>
            <label>
              Allowed models (comma separated, blank allows operator-qualified models)
              <Input name="models" defaultValue={policy.models.join(', ')} />
            </label>
            <label>
              Allowed tools (comma separated)
              <Input name="tools" defaultValue={policy.tools.join(', ')} />
            </label>
            <label>
              Allowed connection providers (comma separated)
              <Input name="providers" defaultValue={policy.connectionProviders.join(', ')} />
            </label>
            <label>
              Model credential policy
              <NativeSelect name="byok" defaultValue={policy.byok}>
                <option value="optional">Operator-managed credentials allowed</option>
                <option value="disabled">Disable BYOK</option>
                <option value="required">Require BYOK; pause unqualified runtimes</option>
              </NativeSelect>
            </label>
            <p className="muted">
              BYOK-required mode blocks the current hosted runtime until a credential-proxy adapter
              is qualified. Region attestations are installed by deployment operators.
            </p>
            <fieldset>
              <legend>Allowed recording modes</legend>
              {(['no_recording', 'transient_captions', 'retained_recording'] as const).map(
                (mode) => (
                  <label key={mode}>
                    <input
                      name="recordingModes"
                      value={mode}
                      type="checkbox"
                      defaultChecked={policy.recordingModes.includes(mode)}
                    />
                    {mode.replaceAll('_', ' ')}
                  </label>
                ),
              )}
            </fieldset>
            <label>
              Source retention (days, blank disables automatic retention)
              <Input
                name="retention"
                type="number"
                min={1}
                max={36500}
                defaultValue={policy.retentionDays ?? ''}
              />
            </label>
            <label>
              Maximum backup lifetime (days)
              <Input
                name="backup"
                type="number"
                min={1}
                max={365}
                required
                defaultValue={policy.backupMaxDays}
              />
            </label>
            <p className="muted">
              Retention preserves legal holds. Backup expiry requires independent signed evidence
              before deletion can be reported complete.
            </p>
            <Button disabled={!owner || busy}>Save governance policy</Button>
          </fieldset>
        </form>
      )}
      <details>
        <summary>Security audit</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void perform(async () => {
              const page = await api<{ items: Audit[]; next: string | null }>(
                path + '/audit?action=' + encodeURIComponent(query),
              );
              setAudit(page.items);
              setNext(page.next);
            });
          }}
        >
          <label>
            Search audit actions
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="support, governance, lifecycle…"
            />
          </label>
          <div className="commercial-actions">
            <Button disabled={busy}>Search audit</Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const proof = await api<{ valid: boolean; through: string }>(
                    path + '/audit/verify',
                  );
                  setMessage(
                    proof.valid
                      ? `Chain verified through event ${proof.through}. Independent signed anchors are needed to detect a rewritten history.`
                      : 'Audit integrity verification failed. Escalate to your security operator.',
                  );
                })
              }
            >
              Verify integrity
            </Button>
            <a href={`/api/v1${path}/audit/export`}>Export audit</a>
            <a href={`/api/v1/organizations/${organizationId}/export`}>Export organization</a>
          </div>
        </form>
        <ul>
          {audit.map((row) => (
            <li key={row.sequence}>
              <strong>{row.action}</strong> · {new Date(row.occurred_at).toLocaleString()}
              <small>{row.resource_id ?? 'Resource hidden by source permissions'}</small>
            </li>
          ))}
        </ul>
        {next && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const page = await api<{ items: Audit[]; next: string | null }>(
                  path + '/audit?action=' + encodeURIComponent(query) + '&after=' + next,
                );
                setAudit((old) => [...old, ...page.items]);
                setNext(page.next);
              })
            }
          >
            Load more audit events
          </Button>
        )}
      </details>
      <details>
        <summary>Legal holds ({holds.filter((h) => !h.released_at).length} active)</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void perform(async () => {
              await post(path + '/holds', {
                workspaceId: data.get('workspace'),
                conversationId: String(data.get('conversation')).trim() || null,
                reason: data.get('reason'),
                reference: data.get('reference'),
              });
              setMessage('Legal hold created. Matching content is preserved.');
            });
          }}
        >
          <WorkspaceChoice workspaces={workspaces} />
          <label>
            Conversation ID (optional; blank covers the workspace)
            <Input name="conversation" />
          </label>
          <label>
            Case reference
            <Input name="reference" required minLength={3} maxLength={200} />
          </label>
          <label>
            Preservation reason
            <Input name="reason" required minLength={20} maxLength={1000} />
          </label>
          <Button disabled={busy}>Create legal hold</Button>
        </form>
        <ul>
          {holds.map((hold) => (
            <li key={hold.id}>
              <strong>{hold.reference}</strong> · {hold.reason}
              {hold.released_at ? (
                <small>Released</small>
              ) : (
                owner && (
                  <div>
                    <label>
                      Release reason for {hold.reference}
                      <Input
                        value={releaseReasons[hold.id] ?? ''}
                        onChange={(e) =>
                          setReleaseReasons((old) => ({ ...old, [hold.id]: e.target.value }))
                        }
                        minLength={20}
                        maxLength={1000}
                      />
                    </label>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || (releaseReasons[hold.id]?.trim().length ?? 0) < 20}
                      onClick={() => {
                        const reason = releaseReasons[hold.id]?.trim();
                        if (reason)
                          void perform(async () => {
                            await api(path + '/holds/' + hold.id, {
                              method: 'DELETE',
                              body: JSON.stringify({ reason }),
                            });
                            setMessage('Hold released. Pending retention jobs may continue.');
                          });
                      }}
                    >
                      Release hold
                    </Button>
                  </div>
                )
              )}
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Support access ({grants.length})</summary>
        <p className="muted">
          The recipient needs a verified account and MFA. Grants expire within two hours and reveal
          only scoped operational counts.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void perform(async () => {
              await post(path + '/support', {
                accountId: data.get('account'),
                workspaceIds: data.getAll('workspace'),
                purpose: data.get('purpose'),
                ticket: data.get('ticket'),
                minutes: Number(data.get('minutes')),
              });
              setMessage('Time-limited diagnostic access granted.');
            });
          }}
        >
          <label>
            Verified support account ID
            <Input name="account" required />
          </label>
          <fieldset>
            <legend>Approved workspaces</legend>
            {workspaces.map((w) => (
              <label key={w.id}>
                <input type="checkbox" name="workspace" value={w.id} />
                {w.name}
              </label>
            ))}
          </fieldset>
          <label>
            Ticket reference
            <Input name="ticket" required minLength={3} />
          </label>
          <label>
            Access purpose
            <Input name="purpose" required minLength={20} maxLength={1000} />
          </label>
          <label>
            Expires after (minutes)
            <Input type="number" name="minutes" min={5} max={120} defaultValue={30} required />
          </label>
          <Button disabled={!owner || busy || !policy?.supportAccess}>
            Grant diagnostic access
          </Button>
        </form>
        <ul>
          {grants.map((g) => (
            <li key={g.id}>
              <strong>{g.ticket}</strong> · {g.purpose}
              <small>Expires {new Date(g.expires_at).toLocaleString()}</small>
              {g.revoked_at ? (
                'Revoked'
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await api(path + '/support/' + g.id, { method: 'DELETE' });
                      setMessage('Support access revoked.');
                    })
                  }
                >
                  Revoke support access
                </Button>
              )}
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Governed erasure ({jobs.length})</summary>
        <p className="muted">
          Request source erasure by its stable resource ID. Storage, runtime/provider copies and
          backups require separate evidence; this is not a whole-organization purge.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void perform(async () => {
              await post(path + '/erasures', {
                workspaceId: data.get('workspace'),
                kind: data.get('kind'),
                sourceId: data.get('source'),
                requestKey: crypto.randomUUID(),
                reason: data.get('reason'),
              });
              setMessage('Erasure queued with preservation and backup checks.');
            });
          }}
        >
          <WorkspaceChoice workspaces={workspaces} />
          <label>
            Source type
            <NativeSelect name="kind">
              {['message', 'task', 'knowledge', 'file', 'transcript'].map((kind) => (
                <option key={kind}>{kind}</option>
              ))}
            </NativeSelect>
          </label>
          <label>
            Source ID
            <Input name="source" required />
          </label>
          <label>
            Erasure reason
            <Input name="reason" minLength={20} maxLength={1000} required />
          </label>
          <Button disabled={!owner || busy}>Request governed erasure</Button>
        </form>
        <ul>
          {jobs.map((job) => (
            <li key={job.id}>
              <strong>{job.kind}</strong> · {job.state.replaceAll('_', ' ')}
              <small>
                Backup evidence after {new Date(job.receipt_after).toLocaleDateString()}
              </small>
            </li>
          ))}
        </ul>
      </details>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() =>
          void perform(async () => {
            const report = await api<{ queues: Record<string, QueueRow[]> }>(
              `/organizations/${organizationId}/operations`,
            );
            setQueues(report.queues);
          })
        }
      >
        Inspect delivery queues
      </Button>
      {queues && (
        <div className="commercial-metrics">
          {Object.entries(queues).map(([name, rows]) => (
            <article key={name}>
              <h4>
                {{
                  developer: 'Signed webhooks',
                  connections: 'Connector events',
                  retrieval: 'Search indexing',
                }[name] ?? name}
              </h4>
              {!rows.length ? (
                <p className="muted">No queued work.</p>
              ) : (
                <ul>
                  {rows.map((row) => (
                    <li key={row.state}>
                      <strong>
                        {row.total} {row.state}
                      </strong>
                      <small>Oldest: {new Date(row.oldest).toLocaleString()}</small>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
function WorkspaceChoice({ workspaces }: { workspaces: { id: string; name: string }[] }) {
  return (
    <label>
      Workspace
      <NativeSelect name="workspace" required>
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </NativeSelect>
    </label>
  );
}
