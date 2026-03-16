import type { FastifyPluginAsync } from 'fastify';
import { sprintService } from '../services/sprint.service.js';

export const sprintRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/sprint/capacity?teamId=X — returns sprint capacity data
  app.get('/sprint/capacity', async (request, reply) => {
    const { teamId } = request.query as { teamId?: string };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId query parameter is required' };
    }

    return sprintService.getSprintCapacity(teamId);
  });

  // POST /api/sprint/check — check capacity and get trade-off suggestions
  app.post('/sprint/check', async (request, reply) => {
    const { teamId, newTicketPoints, newTicketWeight } = request.body as {
      teamId?: string;
      newTicketPoints?: number;
      newTicketWeight?: number;
    };

    if (!teamId) {
      reply.code(400);
      return { error: 'teamId is required' };
    }

    return sprintService.checkSprintCapacity(teamId, newTicketPoints, newTicketWeight);
  });

  // POST /api/sprint/defer — defer a ticket to backlog
  app.post('/sprint/defer', async (request, reply) => {
    const { teamId, ticketKey } = request.body as {
      teamId?: string;
      ticketKey?: string;
    };

    if (!teamId || !ticketKey) {
      reply.code(400);
      return { error: 'teamId and ticketKey are required' };
    }

    return sprintService.deferTicket(teamId, ticketKey);
  });
};
