import {
  AccessToken,
  RoomServiceClient,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
} from 'livekit-server-sdk';
import { AppError } from '../lib/errors.js';

export interface CallMedia {
  readonly url: string;
  readonly recording: boolean;
  ensureRoom(room: string): Promise<void>;
  ticket(room: string, participant: string, name: string): Promise<string>;
  remove(room: string, participant: string): Promise<void>;
  mute(room: string, participant: string): Promise<void>;
  close(room: string): Promise<void>;
  recordings(
    room: string,
  ): Promise<{ id: string; state: 'active' | 'complete' | 'failed'; key: string }[]>;
  record(room: string, key: string): Promise<string>;
  stopRecording(id: string): Promise<void>;
}
export class LiveKitMedia implements CallMedia {
  private readonly rooms: RoomServiceClient;
  private readonly egress: EgressClient;
  constructor(
    readonly url: string,
    private readonly key: string,
    private readonly secret: string,
    readonly recording = false,
  ) {
    const endpoint = new URL(url);
    if (
      !['wss:', 'ws:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== '/' ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error('LIVEKIT_URL must be a WebSocket origin.');
    if (endpoint.protocol === 'ws:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname))
      throw new Error('Unencrypted LiveKit is restricted to loopback.');
    const host = url.replace(/^ws/, 'http');
    this.rooms = new RoomServiceClient(host, key, secret, { requestTimeout: 10 });
    this.egress = new EgressClient(host, key, secret, { requestTimeout: 10 });
  }
  async ensureRoom(room: string) {
    await this.rooms.createRoom({
      name: room,
      emptyTimeout: 120,
      departureTimeout: 20,
      maxParticipants: 50,
    });
  }
  async ticket(room: string, participant: string, name: string) {
    const token = new AccessToken(this.key, this.secret, { identity: participant, name, ttl: 60 });
    token.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: false,
    });
    return token.toJwt();
  }
  async remove(room: string, participant: string) {
    try {
      await this.rooms.removeParticipant(room, participant);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  async mute(room: string, participant: string) {
    const person = await this.rooms.getParticipant(room, participant);
    for (const track of person.tracks.filter((track) => track.source === 2))
      await this.rooms.mutePublishedTrack(room, participant, track.sid, true);
  }
  async close(room: string) {
    try {
      await this.rooms.deleteRoom(room);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  async recordings(room: string) {
    return (await this.egress.listEgress({ roomName: room })).map((info) => ({
      id: info.egressId,
      state:
        info.status === 3
          ? ('complete' as const)
          : [4, 5, 6].includes(info.status)
            ? ('failed' as const)
            : ('active' as const),
      key: info.fileResults[0]?.filename ?? '',
    }));
  }
  async record(room: string, key: string) {
    if (!this.recording)
      throw new AppError(503, 'RECORDING_UNAVAILABLE', 'Recording storage is not configured.');
    const info = await this.egress.startRoomCompositeEgress(
      room,
      new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath: '/recordings/' + key }),
      { layout: 'grid', audioOnly: false },
    );
    return info.egressId;
  }
  async stopRecording(id: string) {
    try {
      await this.egress.stopEgress(id);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}
function missing(error: unknown) {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'not_found'
  );
}
export function configuredMedia(env: NodeJS.ProcessEnv): CallMedia | undefined {
  if (!env.LIVEKIT_URL) return undefined;
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET)
    throw new Error('Configure both LiveKit credentials.');
  if (env.NODE_ENV === 'production' && !env.LIVEKIT_URL.startsWith('wss://'))
    throw new Error('Production calls require WSS.');
  return new LiveKitMedia(
    env.LIVEKIT_URL,
    env.LIVEKIT_API_KEY,
    env.LIVEKIT_API_SECRET,
    Boolean(env.CALL_RECORDING_DIRECTORY),
  );
}
