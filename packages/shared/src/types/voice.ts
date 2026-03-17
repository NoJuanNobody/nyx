import { z } from 'zod';

export const MeetingPlatformSchema = z.enum(['zoom', 'google_meet', 'teams']);
export type MeetingPlatform = z.infer<typeof MeetingPlatformSchema>;

export const CallStateSchema = z.enum([
  'idle',
  'connecting',
  'in_call',
  'disconnecting',
  'ended',
  'error',
]);
export type CallState = z.infer<typeof CallStateSchema>;

export const AudioStreamEventSchema = z.object({
  type: z.enum(['audio_chunk', 'silence', 'end']),
  data: z.string().optional(),
  speakerId: z.string().optional(),
  timestampMs: z.number(),
});
export type AudioStreamEvent = z.infer<typeof AudioStreamEventSchema>;

export const BotOutputEventSchema = z.object({
  type: z.enum(['chat', 'tts']),
  message: z.string(),
  sessionId: z.string().optional(),
  timestampMs: z.number(),
});
export type BotOutputEvent = z.infer<typeof BotOutputEventSchema>;

export const CallSessionSchema = z.object({
  id: z.string().uuid(),
  platform: MeetingPlatformSchema,
  state: CallStateSchema,
  meetingUrl: z.string().url(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().optional(),
});
export type CallSession = z.infer<typeof CallSessionSchema>;
