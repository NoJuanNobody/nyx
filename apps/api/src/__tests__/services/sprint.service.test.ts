import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the database and external services before importing the service
const mockDbSelect = vi.fn();
const mockDbFrom = vi.fn();
const mockDbWhere = vi.fn();

vi.mock('../../db/index.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));

vi.mock('../../services/github.service.js', () => ({
  githubService: {
    listProjects: vi.fn().mockResolvedValue([]),
    getProjectItems: vi.fn().mockResolvedValue({ items: [], title: 'Test' }),
    updateProjectItemStatus: vi.fn(),
  },
}));

vi.mock('../../services/jira.service.js', () => ({
  jiraService: {
    searchIssues: vi.fn().mockResolvedValue([]),
  },
}));

import { sprintService } from '../../services/sprint.service.js';

describe('sprintService', () => {
  beforeEach(() => {
    sprintService._resetDeferred();
  });

  describe('getSprintCapacity', () => {
    it('returns empty sprint when no integration is connected', async () => {
      const result = await sprintService.getSprintCapacity('team-no-integration');

      expect(result.sprintName).toBe('No Sprint');
      expect(result.source).toBe('none');
      expect(result.tickets).toEqual([]);
      expect(result.usedWeight).toBe(0);
      expect(result.capacityPercent).toBe(0);
    });

    it('returns valid sprint structure with expected fields', async () => {
      const result = await sprintService.getSprintCapacity('team-1');

      expect(result).toHaveProperty('sprintName');
      expect(result).toHaveProperty('totalWeight');
      expect(result).toHaveProperty('usedWeight');
      expect(result).toHaveProperty('capacityPercent');
      expect(result).toHaveProperty('tickets');
      expect(result).toHaveProperty('source');
      expect(['github', 'jira', 'none']).toContain(result.source);
    });
  });

  describe('checkSprintCapacity', () => {
    it('returns overThreshold=false when no tickets exist', async () => {
      const result = await sprintService.checkSprintCapacity('team-1');

      expect(result.overThreshold).toBe(false);
      expect(result.capacity.capacityPercent).toBe(0);
    });

    it('returns empty suggestions when under threshold', async () => {
      const result = await sprintService.checkSprintCapacity('team-1');

      expect(result.suggestions).toEqual([]);
    });

    it('accounts for newTicketWeight in projection', async () => {
      // With a very large new ticket weight, should be over threshold
      const result = await sprintService.checkSprintCapacity('team-1', undefined, 200);

      expect(result.overThreshold).toBe(true);
    });

    it('converts newTicketPoints to weight when newTicketWeight not provided', async () => {
      // 100 points * 5 = 500 weight, well over threshold on empty sprint
      const result = await sprintService.checkSprintCapacity('team-1', 100);

      expect(result.overThreshold).toBe(true);
    });
  });

  describe('deferTicket', () => {
    it('returns deferred: true', async () => {
      const result = await sprintService.deferTicket('team-1', 'TICKET-101');
      expect(result).toEqual({ deferred: true });
    });

    it('is idempotent — deferring same ticket twice still works', async () => {
      await sprintService.deferTicket('team-1', 'TICKET-101');
      const result = await sprintService.deferTicket('team-1', 'TICKET-101');
      expect(result).toEqual({ deferred: true });
    });
  });

  describe('scheduleForNextSprint', () => {
    it('returns scheduled ticket keys', async () => {
      const result = await sprintService.scheduleForNextSprint('team-1', ['TICKET-101', 'TICKET-102']);
      expect(result).toEqual({ scheduled: ['TICKET-101', 'TICKET-102'] });
    });
  });
});
