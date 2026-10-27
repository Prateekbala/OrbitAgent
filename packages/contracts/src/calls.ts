import { z } from 'zod';

export const callMode = z.enum(['no_recording', 'transient_captions', 'retained_recording']);
export const callCreate = z
  .object({
    clientId: z.uuid(),
    mode: callMode.default('no_recording'),
    retentionDays: z.number().int().min(1).max(90).default(30),
  })
  .strict();
export const callJoin = z
  .object({
    clientId: z.uuid(),
    consent: z.boolean(),
    voiceAgentConsent: z.boolean().default(false),
  })
  .strict();
export const callTranscriptInput = z
  .object({
    clientId: z.uuid(),
    text: z.string().trim().min(1).max(4000),
    startMs: z.number().int().nonnegative().max(86400000),
    endMs: z.number().int().positive().max(86400000),
  })
  .strict()
  .refine((v) => v.endMs > v.startMs, { message: 'The end must follow the start.' });
export const callCorrection = z
  .object({ version: z.number().int().positive(), text: z.string().trim().min(1).max(4000) })
  .strict();
export const callNotes = z
  .object({
    version: z.number().int().nonnegative(),
    summary: z.string().max(20000),
    chapters: z
      .array(
        z
          .object({
            startMs: z.number().int().nonnegative(),
            title: z.string().trim().min(1).max(160),
          })
          .strict(),
      )
      .max(100),
    proposedActions: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(500),
            assigneeId: z.uuid().nullable(),
            sourceSegmentIds: z.array(z.uuid()).min(1).max(20),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type CallNotes = z.infer<typeof callNotes>;
export interface CallParticipant {
  id: string;
  membership_id: string;
  name: string;
  consent: boolean;
  voice_consent: boolean;
  state: 'joined' | 'left' | 'removed';
}
export interface CallSnapshot {
  id: string;
  conversation_id: string;
  owner_id: string;
  mode: z.infer<typeof callMode>;
  state: 'active' | 'ending' | 'ended';
  room_name: string;
  recording_state: 'off' | 'starting' | 'recording' | 'stopping' | 'stopped' | 'uncertain';
  expires_at: string;
  created_at: string;
  participants: CallParticipant[];
}
export interface CallTicket {
  call: CallSnapshot;
  participantId: string;
  token: string;
  url: string;
}
export interface CallSegment {
  id: string;
  speaker_id: string;
  speaker_name: string;
  text: string;
  start_ms: number;
  end_ms: number;
  version: number;
  source: 'participant_caption';
}
