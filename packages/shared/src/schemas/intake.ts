import { z } from 'zod';

export const intakeProcessBody = z.object({
  rawInput: z.string().min(1),
  teamId: z.string().min(1),
});

export const intakeClarifyBody = z.object({
  rawInput: z.string().min(1),
  questions: z.array(z.string()),
  answers: z.array(z.string()),
  teamId: z.string().min(1),
});

export const intakeHistoryQuery = z.object({
  teamId: z.string().min(1),
});
