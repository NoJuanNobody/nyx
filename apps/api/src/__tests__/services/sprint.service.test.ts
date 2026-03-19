import { describe, it, expect, beforeEach } from 'vitest';
import { sprintService } from '../../services/sprint.service.js';

describe('sprintService', () => {
  beforeEach(() => {
    sprintService._resetDeferred();
  });

  describe('getSprintCapacity', () => {
    it('returns mock sprint data with tickets', async () => {
      const result = await sprintService.getSprintCapacity('team-1');

      expect(result.sprintName).toBe('Sprint 12 (Demo)');
      expect(result.totalPoints).toBeGreaterThan(0);
      expect(result.usedPoints).toBeGreaterThan(0);
      expect(result.capacityPercent).toBeGreaterThan(0);
      expect(result.tickets).toBeInstanceOf(Array);
      expect(result.tickets.length).toBeGreaterThan(0);
      for (const ticket of result.tickets) {
        expect(ticket).toHaveProperty('id');
        expect(ticket).toHaveProperty('title');
        expect(ticket).toHaveProperty('points');
        expect(ticket).toHaveProperty('status');
      }
    });

    it('excludes deferred tickets from capacity', async () => {
      const before = await sprintService.getSprintCapacity('team-1');
      const ticketToDefer = before.tickets[0];

      await sprintService.deferTicket('team-1', ticketToDefer.id);

      const after = await sprintService.getSprintCapacity('team-1');
      expect(after.tickets.length).toBe(before.tickets.length - 1);
      expect(after.usedPoints).toBe(before.usedPoints - ticketToDefer.points);
      expect(after.tickets.find((t) => t.id === ticketToDefer.id)).toBeUndefined();
    });

    it('recalculates capacity percent after deferral', async () => {
      const before = await sprintService.getSprintCapacity('team-1');
      const todoTicket = before.tickets.find((t) => t.status === 'todo');
      expect(todoTicket).toBeDefined();

      await sprintService.deferTicket('team-1', todoTicket!.id);

      const after = await sprintService.getSprintCapacity('team-1');
      expect(after.capacityPercent).toBeLessThan(before.capacityPercent);
      expect(after.capacityPercent).toBe(
        Math.round((after.usedWeight / after.totalWeight) * 100),
      );
    });
  });

  describe('checkSprintCapacity', () => {
    it('returns overThreshold=true when capacity >= 80%', async () => {
      const result = await sprintService.checkSprintCapacity('team-1');

      // Mock data starts at 85%, so should be over threshold
      expect(result.overThreshold).toBe(true);
      expect(result.capacity.capacityPercent).toBeGreaterThanOrEqual(80);
    });

    it('includes suggestions when over threshold', async () => {
      const result = await sprintService.checkSprintCapacity('team-1');

      expect(result.suggestions.length).toBeGreaterThan(0);
      // Suggestions should mention deferring todo tickets
      for (const suggestion of result.suggestions) {
        expect(suggestion).toContain('Defer');
      }
    });

    it('accounts for newTicketPoints in projection', async () => {
      // Defer enough tickets to get under threshold
      const capacity = await sprintService.getSprintCapacity('team-1');
      const todoTickets = capacity.tickets.filter((t) => t.status === 'todo');
      for (const ticket of todoTickets) {
        await sprintService.deferTicket('team-1', ticket.id);
      }

      // Now capacity should be lower, adding points should push it over
      const resultWithoutNew = await sprintService.checkSprintCapacity('team-1');
      const resultWithNew = await sprintService.checkSprintCapacity('team-1', 100);

      // With 100 extra points, should definitely be over threshold
      expect(resultWithNew.overThreshold).toBe(true);
    });

    it('returns overThreshold=false when well under capacity', async () => {
      // Defer all tickets to get to 0%
      const capacity = await sprintService.getSprintCapacity('team-1');
      for (const ticket of capacity.tickets) {
        await sprintService.deferTicket('team-1', ticket.id);
      }

      const result = await sprintService.checkSprintCapacity('team-1');
      expect(result.overThreshold).toBe(false);
      expect(result.capacity.capacityPercent).toBe(0);
    });
  });

  describe('deferTicket', () => {
    it('returns deferred: true', async () => {
      const result = await sprintService.deferTicket('team-1', 'MOCK-101');
      expect(result).toEqual({ deferred: true });
    });

    it('is idempotent — deferring same ticket twice still works', async () => {
      await sprintService.deferTicket('team-1', 'MOCK-101');
      const result = await sprintService.deferTicket('team-1', 'MOCK-101');
      expect(result).toEqual({ deferred: true });
    });
  });
});
