'use client';
import { WorkspaceHeading } from './workspace-heading';
import { ArrowRightLeft } from 'lucide-react';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { useEffect, useRef, useState } from 'react';
import type { Bootstrap } from '@ao/contracts';
import type { MigrationRecord } from '@ao/contracts/interoperability';
import { api, post } from '../lib/api';
interface Source {
  id: string;
  name: string;
  provider: 'slack' | 'teams' | 'discord';
  state: string;
  version: number;
  mode: string;
}
interface Mapping {
  external_id: string;
  conversation_id: string;
  visibility: 'public' | 'private';
  expansion_ack: boolean;
  target_name: string;
}
interface Report {
  source: Source & { cursor: string | null };
  channels: Mapping[];
  identities: { source_id: string; name: string; membership_id: string | null }[];
  counts: { state: string; count: number }[];
  issues: {
    id: string;
    state: string;
    reason: string | null;
    version: number;
    external_id: string;
    missing_files: number;
    unsupported: string[];
  }[];
  complete: boolean;
  hasOmissions: boolean;
  reportTruncated: boolean;
  unmappedIdentities: { source_id: string; name: string }[];
  checksums: { external_channel_id: string; messages: number; checksum: string }[];
}
interface DryRun {
  audiences: {
    sourceChannelId: string;
    targetName: string;
    visibility: string;
    participants: { id: string; name: string }[];
  }[];
  blockers: { id: string; external_id: string; reason: string }[];
  truncated: boolean;
}
interface Delivery {
  id: string;
  state: string;
  version: number;
  attempts: number;
  message_id: string;
  external_id: string | null;
}
export function MigrationHub({ boot }: { boot: Bootstrap }) {
  const [sources, setSources] = useState<Source[]>([]),
    [selected, setSelected] = useState(''),
    [report, setReport] = useState<Report | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0),
    [secret, setSecret] = useState('');
  const [sourceChannel, setSourceChannel] = useState(''),
    [target, setTarget] = useState(''),
    [visibility, setVisibility] = useState<'private' | 'public'>('private'),
    [ack, setAck] = useState(false);
  const [dryRun, setDryRun] = useState<DryRun | null>(null),
    [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const createRequest = useRef<{ body: string; clientId: string } | null>(null);
  const staged = useRef<{ file: File; clientId: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<Source[]>('/migrations', { signal: controller.signal })
      .then(setSources)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    setSecret('');
    setDryRun(null);
    setDeliveries([]);
  }, [selected]);
  useEffect(() => {
    setReport(null);
    if (!selected) return;
    const controller = new AbortController();
    api<Report>('/migrations/' + selected, { signal: controller.signal })
      .then(setReport)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [selected, revision]);
  async function run(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
      setRevision((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }
  const admin = ['owner', 'admin'].includes(boot.me.role) && boot.me.access_type === 'member';
  if (!admin)
    return (
      <div className="view-padding">
        <h2>Migration and synchronization</h2>
        <p>A workspace administrator manages migrations.</p>
      </div>
    );
  return (
    <div className="view-padding platform-view migration-page">
      <WorkspaceHeading
        icon={ArrowRightLeft}
        eyebrow="Bring your context with you"
        title="Migration and synchronization"
        description="Review permissions, map identities, and preview the import before bringing history into your workspace."
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <section className="platform-card">
        <h3>Create a migration</h3>
        <form
          className="platform-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget,
              data = new FormData(form);
            void run(async () => {
              const r = await post<{ id: string }>('/migrations', {
                clientId: (() => {
                  const body = JSON.stringify(Object.fromEntries(data.entries()));
                  if (createRequest.current?.body !== body)
                    createRequest.current = { body, clientId: crypto.randomUUID() };
                  return createRequest.current.clientId;
                })(),
                name: data.get('name'),
                provider: data.get('provider'),
                sourceWorkspaceId: data.get('sourceWorkspaceId'),
                mode: data.get('mode'),
                conflictOwner: data.get('conflictOwner'),
              });
              setSelected(r.id);
              form.reset();
            });
          }}
        >
          <label>
            Name
            <Input required name="name" maxLength={100} />
          </label>
          <label>
            Provider
            <NativeSelect name="provider">
              <option value="slack">Slack</option>
              <option value="teams">Microsoft Teams</option>
              <option value="discord">Discord</option>
            </NativeSelect>
          </label>
          <label>
            Source workspace ID
            <Input name="sourceWorkspaceId" required maxLength={200} />
          </label>
          <label>
            Mode
            <NativeSelect name="mode">
              <option value="import">History import</option>
              <option value="inbound">Ongoing inbound</option>
              <option value="bidirectional">Bidirectional relay</option>
            </NativeSelect>
          </label>
          <label>
            Conflict ownership
            <NativeSelect name="conflictOwner">
              <option value="manual">Review conflicts</option>
              <option value="source">Source owns unchanged imports</option>
              <option value="local">Keep local revisions</option>
            </NativeSelect>
          </label>
          <Button className="primary" disabled={busy}>
            Create paused migration
          </Button>
        </form>
      </section>
      <label>
        Migration
        <NativeSelect
          aria-label="Migration"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">Choose a migration</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.state}
            </option>
          ))}
        </NativeSelect>
      </label>
      {report && (
        <>
          <section className="platform-card">
            <h3>{report.source.name}</h3>
            <p>
              {report.source.state} ·{' '}
              {report.complete ? 'All staged records resolved' : 'Import incomplete'}
              {report.hasOmissions ? ' · omissions require review' : ''}
            </p>
            <div className="button-row">
              {['start', 'pause', 'disconnect'].map((action) => (
                <Button
                  variant="outline"
                  key={action}
                  disabled={busy || report.source.state === 'disconnected'}
                  onClick={() =>
                    void run(() =>
                      post('/migrations/' + selected + '/control', {
                        action,
                        version: report.source.version,
                      }),
                    )
                  }
                >
                  {action === 'start'
                    ? 'Start / resume'
                    : action === 'pause'
                      ? 'Pause'
                      : 'Disconnect'}
                </Button>
              ))}
              <Button
                variant="outline"
                disabled={busy || report.source.state !== 'active'}
                onClick={() => void run(() => post('/migrations/' + selected + '/process', {}))}
              >
                Process next batch
              </Button>
              <Button variant="outline" onClick={() => setRevision((v) => v + 1)}>
                Refresh report
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    setDryRun(await post<DryRun>('/migrations/' + selected + '/preflight', {})),
                  )
                }
              >
                Run preflight
              </Button>
            </div>
            <p>
              {report.counts.map((c) => `${c.count} ${c.state}`).join(' · ') || 'No records staged'}
            </p>
            {report.source.cursor && <p>Applied checkpoint: {report.source.cursor}</p>}
          </section>
          {dryRun && (
            <section className="platform-card">
              <h3>Dry-run permission preview</h3>
              {dryRun.audiences.map((a) => (
                <p key={a.sourceChannelId}>
                  {a.sourceChannelId} → {a.targetName} ({a.visibility}); explicit participants:{' '}
                  {a.participants.map((p) => p.name).join(', ') || 'none'}
                </p>
              ))}
              {dryRun.blockers.map((b) => (
                <p key={b.id}>
                  {b.external_id}: {b.reason}
                </p>
              ))}
              {!dryRun.blockers.length && (
                <p>
                  No mapping, thread or retention blockers found. Missing file bodies and
                  unsupported content remain in the completeness report.
                </p>
              )}
              {dryRun.truncated && <p>Preview is bounded to 1,000 staged records.</p>}
            </section>
          )}
          <section className="platform-card">
            <h3>Reviewed channel mapping</h3>
            {report.channels.map((c) => (
              <p key={c.external_id}>
                {c.external_id} → {c.target_name} ({c.visibility})
              </p>
            ))}
            <form
              className="platform-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  api('/migrations/' + selected + '/mappings', {
                    method: 'PUT',
                    body: JSON.stringify({
                      version: report.source.version,
                      channels: [
                        ...report.channels
                          .filter((c) => c.external_id !== sourceChannel)
                          .map((c) => ({
                            sourceId: c.external_id,
                            conversationId: c.conversation_id,
                            visibility: c.visibility,
                            authorized: true,
                            acknowledgeAudienceExpansion: c.expansion_ack,
                          })),
                        {
                          sourceId: sourceChannel,
                          conversationId: target,
                          visibility,
                          authorized: true,
                          acknowledgeAudienceExpansion: ack,
                        },
                      ],
                      identities: report.identities.map((i) => ({
                        sourceId: i.source_id,
                        name: i.name,
                        membershipId: i.membership_id,
                      })),
                    }),
                  }),
                );
              }}
            >
              <label>
                Source channel ID
                <Input
                  required
                  value={sourceChannel}
                  onChange={(e) => setSourceChannel(e.target.value)}
                />
              </label>
              <label>
                Source visibility
                <NativeSelect
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as 'private' | 'public')}
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </NativeSelect>
              </label>
              <label>
                Target channel
                <NativeSelect
                  aria-label="Target channel"
                  required
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">Choose a channel</option>
                  {boot.channels
                    .filter((c) => c.kind === 'channel')
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.visibility})
                      </option>
                    ))}
                </NativeSelect>
              </label>
              <label>
                <Input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I
                am authorized to import this source and have reviewed the target audience, including
                any expansion.
              </label>
              <Button variant="outline" disabled={busy || report.source.state !== 'paused'}>
                Save channel mapping
              </Button>
            </form>
          </section>
          <section className="platform-card">
            <h3>Identity reconciliation</h3>
            <p>
              Unmapped authors retain their external names. Mapping never creates an account or adds
              channel participants.
            </p>
            {report.unmappedIdentities.map((i) => (
              <label key={i.source_id}>
                {i.name} ({i.source_id})
                <NativeSelect
                  aria-label={'Map ' + i.source_id}
                  disabled={busy || report.source.state !== 'paused' || !report.channels.length}
                  value=""
                  onChange={(e) => {
                    const member = e.target.value;
                    void run(() =>
                      api('/migrations/' + selected + '/mappings', {
                        method: 'PUT',
                        body: JSON.stringify({
                          version: report.source.version,
                          channels: report.channels.map((c) => ({
                            sourceId: c.external_id,
                            conversationId: c.conversation_id,
                            visibility: c.visibility,
                            authorized: true,
                            acknowledgeAudienceExpansion: c.expansion_ack,
                          })),
                          identities: [
                            ...report.identities
                              .filter((v) => v.source_id !== i.source_id)
                              .map((v) => ({
                                sourceId: v.source_id,
                                name: v.name,
                                membershipId: v.membership_id,
                              })),
                            { sourceId: i.source_id, name: i.name, membershipId: member || null },
                          ],
                        }),
                      }),
                    );
                  }}
                >
                  <option value="">Keep external attribution</option>
                  {boot.members
                    .filter((m) => m.kind === 'human')
                    .map((m) => (
                      <option value={m.id} key={m.id}>
                        {m.name}
                      </option>
                    ))}
                </NativeSelect>
              </label>
            ))}
          </section>
          <section className="platform-card">
            <h3>Stage a dry run</h3>
            <p>
              Upload a provider JSON message array or a normalized batch containing records (at most
              100 per page, 350 KB). Staging does not publish messages. Inspect the report before
              starting.
            </p>
            <Input
              type="file"
              accept="application/json,.json"
              aria-label="Import JSON page"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (!sourceChannel) {
                  setError('Enter the source channel ID before staging a provider page.');
                  return;
                }
                if (file.size > 350000) {
                  setError('Split the export into pages smaller than 350 KB.');
                  return;
                }
                if (staged.current?.file !== file)
                  staged.current = { file, clientId: crypto.randomUUID() };
                const clientId = staged.current.clientId;
                void run(async () => {
                  const data: unknown = JSON.parse(await file.text());
                  const records = Array.isArray(data)
                    ? (
                        await post<{ records: MigrationRecord[] }>('/migration-normalize', {
                          provider: report.source.provider,
                          channelId: sourceChannel,
                          messages: data,
                        })
                      ).records
                    : (data as { records: MigrationRecord[] }).records;
                  await post('/migrations/' + selected + '/batches', {
                    clientId,
                    complete: true,
                    records,
                  });
                });
              }}
            />
            {report.issues.map((i) => (
              <div key={i.id}>
                <p>
                  {i.external_id}: {i.reason ?? i.state}
                  {i.missing_files ? ` · ${i.missing_files} file bodies need mapping` : ''}
                  {i.unsupported?.length ? ' · ' + i.unsupported.join('; ') : ''}
                </p>
                {['conflict', 'pending'].includes(i.state) && (
                  <div className="button-row">
                    {['source', 'local', 'omit'].map((action) => (
                      <Button
                        variant="outline"
                        key={action}
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            post('/migrations/' + selected + '/records/' + i.id + '/resolve', {
                              action,
                              version: i.version,
                            }),
                          )
                        }
                      >
                        {action === 'source'
                          ? 'Apply source revision'
                          : action === 'local'
                            ? 'Keep local revision'
                            : 'Explicitly omit'}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {report.reportTruncated && (
              <p>Showing the first 200 issues. Resolve these and refresh to continue.</p>
            )}
          </section>
          {report.source.mode !== 'import' && (
            <section className="platform-card">
              <h3>Synchronization relay</h3>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    setDeliveries(await api<Delivery[]>('/migrations/' + selected + '/deliveries')),
                  )
                }
              >
                Inspect sync deliveries
              </Button>
              {deliveries.map((d) => (
                <div key={d.id}>
                  <p>
                    {d.message_id} · {d.state} · {d.attempts} attempts
                  </p>
                  {d.state === 'uncertain' && (
                    <form
                      className="platform-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const data = new FormData(e.currentTarget);
                        void run(async () => {
                          await post(
                            '/migrations/' + selected + '/deliveries/' + d.id + '/reconcile',
                            {
                              version: d.version,
                              outcome: data.get('outcome'),
                              externalId: data.get('externalId') || undefined,
                              confirmedNotApplied: data.get('confirmed') === 'on',
                              evidence: data.get('evidence'),
                            },
                          );
                          setDeliveries(
                            await api<Delivery[]>('/migrations/' + selected + '/deliveries'),
                          );
                        });
                      }}
                    >
                      <label>
                        Confirmed outcome
                        <NativeSelect name="outcome">
                          <option value="completed">Provider confirms completion</option>
                          <option value="retry">Provider confirms no effect; retry</option>
                          <option value="cancelled">Cancel further delivery</option>
                        </NativeSelect>
                      </label>
                      <label>
                        Confirmed provider message ID
                        <Input name="externalId" maxLength={200} />
                      </label>
                      <label>
                        Reconciliation evidence
                        <Textarea required name="evidence" minLength={10} maxLength={2000} />
                      </label>
                      <label>
                        <Input type="checkbox" name="confirmed" />I checked the provider and
                        confirmed this action did not execute (required to retry).
                      </label>
                      <Button variant="outline" disabled={busy}>
                        Record reconciliation
                      </Button>
                    </form>
                  )}
                </div>
              ))}
              <p>
                Use the documented signed relay protocol for inbound pages and approved outbound
                delivery. Rotation fences active leases. Interrupted writes require reconciliation.
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await post<{ secret: string }>(
                      '/migrations/' + selected + '/relay-secret',
                      {},
                    );
                    setSecret(result.secret);
                  })
                }
              >
                Rotate relay secret
              </Button>
              {secret && (
                <p>
                  <strong>Copy this secret now; it is shown once.</strong>
                  <output className="one-time-secret">{secret}</output>
                </p>
              )}
            </section>
          )}
        </>
      )}
      <section className="platform-card">
        <h3>Readable workspace export</h3>
        <p>
          Includes accessible messages, tasks, knowledge, projects and retained files with a
          readable omission manifest. Agreed shared-channel export restrictions apply.
        </p>
        <Button asChild variant="outline">
          <a href="/api/v1/workspace-export" download>
            Download workspace archive
          </a>
        </Button>
      </section>
    </div>
  );
}
