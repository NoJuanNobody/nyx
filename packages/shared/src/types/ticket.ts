import { z } from 'zod';

export const TicketProvider = z.enum(['github', 'jira']);
export type TicketProvider = z.infer<typeof TicketProvider>;

export const TicketStatus = z.enum(['open', 'in_progress', 'closed']);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const TicketSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  provider: TicketProvider,
  externalId: z.string(),
  externalUrl: z.string().url(),
  title: z.string(),
  status: TicketStatus,
  createdById: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Ticket = z.infer<typeof TicketSchema>;
