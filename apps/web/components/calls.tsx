'use client';
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Phone, ShieldCheck } from 'lucide-react';
import type { CallSnapshot, CallTicket } from '@ao/contracts/calls';
import { CallTranscript } from './call-transcript';
const CallRoom = dynamic(() => import('./call-room').then((module) => module.CallRoom), {
  ssr: false,
  loading: () => <p role="status">Loading call controls…</p>,
});
import { api, post } from '../lib/api';
import { Button } from './ui/button';
import { NativeSelect } from './ui/native-select';
import { Input } from './ui/input';
import { Dialog } from './dialog';
import { CallNotesEditor } from './call-notes';

type CallListItem = Pick<CallSnapshot, 'id' | 'mode' | 'state' | 'created_at' | 'recording_state'>;
export function Calls({ conversation, me }: { conversation: string; me: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" aria-label="Open calls" onClick={() => setOpen(true)}>
        <Phone size={18} />
        <span>Call</span>
      </Button>
      {open && (
        <CallPanel
          key={conversation}
          conversation={conversation}
          me={me}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
function CallPanel({
  conversation,
  me,
  onClose,
}: {
  conversation: string;
  me: string;
  onClose: () => void;
}) {
  const [calls, setCalls] = useState<CallListItem[]>([]),
    [selected, setSelected] = useState<CallSnapshot | null>(null),
    [ticket, setTicket] = useState<CallTicket | null>(null),
    [mode, setMode] = useState<CallSnapshot['mode']>('no_recording'),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [capabilities, setCapabilities] = useState<{ calls: boolean; recording: boolean } | null>(null);
  const selectedId = selected?.id;
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const options = { signal: controller.signal };
        const [rows, cap] = await Promise.all([
          api<CallListItem[]>(`/conversations/${conversation}/calls`, options),
          api<{ calls: boolean; recording: boolean }>('/calls/capabilities', options),
        ]);
        setCalls(rows);
        setCapabilities(cap);
        if (selectedId) setSelected(await api<CallSnapshot>(`/calls/${selectedId}`, options));
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to load calls.');
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [conversation, selectedId]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Call action failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Calls" onClose={onClose}>
      <div className="call-panel">
        <div className="call-privacy">
          <ShieldCheck size={20} />
          <div>
            <strong>Choose how this call is handled</strong>
            <p>
              Recording and transcription require consent. Voice agents are disabled until a
              separately authorized runtime is available.
            </p>
          </div>
        </div>
        {!ticket && !selected && (
          <>
            <label>
              Call privacy
              <NativeSelect
                value={mode}
                onChange={(event) => setMode(event.target.value as CallSnapshot['mode'])}
              >
                <option value="no_recording">No recording or transcription</option>
                <option value="transient_captions">Transient captions · never retained</option>
                <option value="retained_recording" disabled={!capabilities?.recording}>
                  Retained recording · 30-day retention
                </option>
              </NativeSelect>
            </label>
            <Button
              disabled={busy || !capabilities?.calls}
              onClick={() =>
                void run(async () => {
                  setSelected(
                    await post<CallSnapshot>(`/conversations/${conversation}/calls`, {
                      clientId: crypto.randomUUID(),
                      mode,
                    }),
                  );
                  setConsent(false);
                })
              }
            >
              <Phone size={16} />
              Start a call
            </Button>
            {capabilities && !capabilities.calls && (
              <p className="muted">
                The operator needs to start and configure the LiveKit media service before calls are
                available.
              </p>
            )}
            <div className="call-history">
              <h3>Recent calls</h3>
              {calls.length === 0 ? (
                <p className="muted">Your conversation’s calls will appear here.</p>
              ) : (
                calls.map((call) => (
                  <Button
                    variant="outline"
                    key={call.id}
                    onClick={() =>
                      void run(async () => {
                        setSelected(await api<CallSnapshot>(`/calls/${call.id}`));
                        setConsent(false);
                      })
                    }
                  >
                    <Phone size={16} />
                    <span>{new Date(call.created_at).toLocaleString()}</span>
                    <span>
                      {call.state === 'active'
                        ? 'Join call'
                        : call.state === 'ending'
                          ? 'Ending…'
                          : 'View transcript'}
                    </span>
                  </Button>
                ))
              )}
            </div>
          </>
        )}
        {selected && (
          <>
            <div className="call-state" role="status">
              <span className={selected.recording_state === 'recording' ? 'recording-dot' : ''} />
              <strong>
                {selected.mode === 'no_recording'
                  ? 'No recording'
                  : selected.mode === 'transient_captions'
                    ? 'Transient captions'
                    : `Recording: ${selected.recording_state}`}
              </strong>
              <span>{selected.state}</span>
            </div>
            {selected.mode !== 'no_recording' && (
              <p className="muted">
                {selected.mode === 'transient_captions'
                  ? 'Captions stay in the call and disappear when you leave.'
                  : 'Audio and video may be recorded after you join. Recordings and captions expire on ' +
                    new Date(selected.expires_at).toLocaleDateString() +
                    '. Captions are supplied by participants and can be corrected.'}
              </p>
            )}
            {!ticket && selected.state === 'active' && (
              <>
                <label className="call-consent">
                  <Input
                    type="checkbox"
                    checked={consent}
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  {selected.mode === 'no_recording'
                    ? 'I understand this call does not retain recordings or captions.'
                    : 'I consent to this call’s recording/transcription mode.'}
                </label>
                <Button
                  disabled={busy || !consent}
                  onClick={() =>
                    void run(async () => {
                      setTicket(
                        await post<CallTicket>(`/calls/${selected.id}/join`, {
                          clientId: crypto.randomUUID(),
                          consent,
                          voiceAgentConsent: false,
                        }),
                      );
                    })
                  }
                >
                  Join call
                </Button>
              </>
            )}
            {ticket && (
              <CallRoom ticket={ticket} onLeft={() => setTicket(null)} onError={setError} />
            )}
            <div className="call-participants">
              <h3>Participants</h3>
              {selected.participants.map((participant) => (
                <div key={participant.id}>
                  <span>{participant.name}</span>
                  <span className="muted">
                    {selected.mode === 'no_recording'
                      ? 'No recording'
                      : participant.consent
                        ? 'Consented'
                        : 'Consent pending'}
                  </span>
                  {selected.owner_id === me && participant.membership_id !== me && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void run(async () => {
                            await post(`/calls/${selected.id}/mute`, {
                              participantId: participant.id,
                            });
                          })
                        }
                      >
                        Mute
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void run(async () => {
                            await post(`/calls/${selected.id}/remove`, {
                              participantId: participant.id,
                            });
                          })
                        }
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </div>
            {selected.state === 'active' && selected.owner_id === me && (
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await post(`/calls/${selected.id}/end`, {});
                    setSelected({ ...selected, state: 'ending' });
                  })
                }
              >
                End call for everyone
              </Button>
            )}
            {selected.mode === 'retained_recording' && <CallTranscript call={selected} me={me} />}
            {selected.mode === 'retained_recording' && (
              <CallNotesEditor
                key={selected.id}
                callId={selected.id}
                canEdit={selected.owner_id === me}
              />
            )}
            {!ticket && (
              <Button variant="ghost" onClick={() => setSelected(null)}>
                Back to calls
              </Button>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
