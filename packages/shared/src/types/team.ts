import { z } from 'zod';
import { UserRole } from './user.js';

export const TeamSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Team = z.infer<typeof TeamSchema>;

export const TeamMemberSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  userId: z.string().uuid(),
  role: UserRole,
  joinedAt: z.string().datetime(),
});

export type TeamMember = z.infer<typeof TeamMemberSchema>;
