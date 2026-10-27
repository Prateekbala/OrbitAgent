'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  setLogLevel,
  LogLevel,
  type Participant,
  type RemoteTrack,
  type LocalTrack,
} from 'livekit-client';
import { Mic, MicOff, Video, VideoOff, MonitorUp, PhoneOff } from 'lucide-react';
import type { CallTicket } from '@ao/contracts/calls';
import { post } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
setLogLevel(LogLevel.warn);
function MediaTrack({ track, local }: { track: RemoteTrack | LocalTrack; local: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = track.attach();
    if (element instanceof HTMLVideoElement) {
      element.playsInline = true;
      element.muted = local;
    }
    if (local && element instanceof HTMLAudioElement) element.muted = true;
    container.current?.appendChild(element);
    return () => {
      track.detach(element);
      element.remove();
    };
  }, [track, local]);
  return (
    <div
      ref={container}
      className={track.kind === Track.Kind.Audio ? 'call-audio' : 'call-video'}
    />
  );
}
export function CallRoom({
  ticket,
  onLeft,
  onError,
}: {
  ticket: CallTicket;
  onLeft: () => void;
  onError: (error: string) => void;
}) {
  const [room] = useState(() => new Room({ adaptiveStream: true, dynacast: true })),
    [version, setVersion] = useState(0),
    [connected, setConnected] = useState(false),
    [mic, setMic] = useState(false),
    [camera, setCamera] = useState(false),
    [screen, setScreen] = useState(false),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [caption, setCaption] = useState(''),
    [captionInput, setCaptionInput] = useState('');
  const callId = ticket.call.id;
  useEffect(() => {
    let closed = false;
    const controller = new AbortController();
    const refresh = () => {
      setVersion((v) => v + 1);
      setMic(room.localParticipant.isMicrophoneEnabled);
      setCamera(room.localParticipant.isCameraEnabled);
      setScreen(room.localParticipant.isScreenShareEnabled);
    };
    const data = (
      payload: Uint8Array,
      participant?: Participant,
      _kind?: unknown,
      topic?: string,
    ) => {
      if (
        topic !== 'orbit.caption' ||
        ticket.call.mode === 'no_recording' ||
        payload.byteLength > 5000
      )
        return;
      try {
        const value = JSON.parse(new TextDecoder().decode(payload)) as { text?: unknown };
        if (typeof value.text === 'string')
          setCaption(`${participant?.name ?? 'Participant'}: ${value.text.slice(0, 1000)}`);
      } catch {}
    };
    room
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.AudioPlaybackStatusChanged, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.TrackSubscribed, refresh)
      .on(RoomEvent.TrackUnsubscribed, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.DataReceived, data)
      .on(RoomEvent.Disconnected, () => {
        if (!closed) {
          setConnected(false);
          onError('Disconnected from the call. Leave and rejoin to reconnect.');
        }
      });
    void room
      .connect(ticket.url, ticket.token)
      .then(async () => {
        if (closed) {
          await room.disconnect();
          return;
        }
        setConnected(true);
        await room.startAudio().catch(() => {});
        setDevices(await Room.getLocalDevices(undefined, false));
      })
      .catch((e) => {
        if (!closed) onError(e instanceof Error ? e.message : 'Unable to connect media.');
      });
    let heartbeatPending = false;
    const timer = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = true;
      void post(`/calls/${callId}/heartbeat`, { participantId: ticket.participantId })
        .catch(() => {
          if (!closed) {
            void room.disconnect();
            onError('Your call authorization expired. Leave and rejoin.');
          }
        })
        .finally(() => {
          heartbeatPending = false;
        });
    }, 15000);
    return () => {
      closed = true;
      controller.abort();
      clearInterval(timer);
      room.removeAllListeners();
      void room.disconnect();
      void fetch(`/api/v1/calls/${callId}/leave`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ participantId: ticket.participantId }),
        keepalive: true,
      }).catch(() => {});
    };
  }, [room, ticket, callId, onError]);
  useEffect(() => {
    if (!caption) return;
    const timer = setTimeout(() => setCaption(''), 8000);
    return () => clearTimeout(timer);
  }, [caption]);
  const control = async (work: () => Promise<void>) => {
    try {
      await work();
      setVersion((v) => v + 1);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Device control failed.');
    }
  };
  const participants = [room.localParticipant, ...room.remoteParticipants.values()];
  void version;
  return (
    <section className="call-room" aria-label="Live call">
      <p role="status" className="muted">
        {connected ? 'Connected' : 'Connecting to the call…'}
      </p>
      <div className="call-stage">
        {participants.map((person) => (
          <div className="call-tile" key={person.identity || 'local'}>
            {[...person.trackPublications.values()]
              .filter(
                (publication) =>
                  publication.track && (!person.isLocal || publication.kind !== Track.Kind.Audio),
              )
              .map((publication) => (
                <MediaTrack
                  key={publication.trackSid}
                  track={publication.track!}
                  local={person.isLocal}
                />
              ))}
            <span>{person.isLocal ? 'You' : person.name || 'Participant'}</span>
          </div>
        ))}
      </div>
      <div className="call-controls">
        {connected && !room.canPlaybackAudio && (
          <Button variant="outline" onClick={() => void control(() => room.startAudio())}>
            Enable call audio
          </Button>
        )}
        <Button
          variant="outline"
          disabled={!connected}
          aria-label={mic ? 'Mute microphone' : 'Unmute microphone'}
          aria-pressed={mic}
          onClick={() =>
            void control(async () => {
              await room.localParticipant.setMicrophoneEnabled(!mic);
              setMic(!mic);
              setDevices(await Room.getLocalDevices(undefined, false));
            })
          }
        >
          {mic ? <Mic /> : <MicOff />}
        </Button>
        <Button
          variant="outline"
          disabled={!connected}
          aria-label={camera ? 'Stop camera' : 'Start camera'}
          aria-pressed={camera}
          onClick={() =>
            void control(async () => {
              await room.localParticipant.setCameraEnabled(!camera);
              setCamera(!camera);
              setDevices(await Room.getLocalDevices(undefined, false));
            })
          }
        >
          {camera ? <Video /> : <VideoOff />}
        </Button>
        <Button
          variant="outline"
          disabled={!connected}
          aria-label="Share screen"
          aria-pressed={screen}
          onClick={() =>
            void control(async () => {
              await room.localParticipant.setScreenShareEnabled(!screen);
              setScreen(!screen);
            })
          }
        >
          <MonitorUp />
        </Button>
        <Button
          variant="destructive"
          onClick={() =>
            void control(async () => {
              await room.disconnect();
              await post(`/calls/${callId}/leave`, { participantId: ticket.participantId });
              onLeft();
            })
          }
        >
          <PhoneOff />
          Leave
        </Button>
      </div>
      <div className="call-devices">
        {(['audioinput', 'videoinput', 'audiooutput'] as const).map((kind) => (
          <label key={kind}>
            {kind === 'audioinput' ? 'Microphone' : kind === 'videoinput' ? 'Camera' : 'Speaker'}
            <NativeSelect
              disabled={!connected}
              defaultValue="default"
              onChange={(event) =>
                void control(async () => {
                  await room.switchActiveDevice(kind, event.target.value);
                })
              }
            >
              <option value="default">System default</option>
              {devices
                .filter((d) => d.kind === kind && d.deviceId !== 'default')
                .map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Device'}
                  </option>
                ))}
            </NativeSelect>
          </label>
        ))}
      </div>
      {ticket.call.mode !== 'no_recording' && (
        <>
          <p className="call-caption" aria-live="polite">
            {caption || 'Captions appear here when participants share them.'}
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const text = captionInput.trim();
              if (!text) return;
              void control(async () => {
                await room.localParticipant.publishData(
                  new TextEncoder().encode(JSON.stringify({ text })),
                  { reliable: true, topic: 'orbit.caption' },
                );
                if (ticket.call.mode === 'retained_recording') {
                  const start = Math.max(
                    0,
                    Date.now() - new Date(ticket.call.created_at).getTime(),
                  );
                  await post(`/calls/${callId}/transcript`, {
                    clientId: crypto.randomUUID(),
                    text,
                    startMs: start,
                    endMs: start + 1,
                  });
                }
                setCaptionInput('');
              });
            }}
          >
            <label>
              Share your caption
              <Input
                maxLength={1000}
                value={captionInput}
                onChange={(event) => setCaptionInput(event.target.value)}
                placeholder="Type a caption for the call"
              />
            </label>
            <Button size="sm" disabled={!connected || !captionInput.trim()}>
              Share caption
            </Button>
          </form>
        </>
      )}
      {ticket.call.mode !== 'no_recording' && (
        <Button
          variant="ghost"
          onClick={() =>
            void control(async () => {
              await room.disconnect();
              await post(`/calls/${callId}/leave`, {
                participantId: ticket.participantId,
                withdraw: true,
              });
              onLeft();
            })
          }
        >
          Withdraw consent and end this recorded/captioned call
        </Button>
      )}
    </section>
  );
}
