// Sprint capacity service: fetches active sprint data from Jira/Linear,
// checks capacity, and supports deferring tickets to backlog.

export interface SprintTicket {
  id: string;
  title: string;
  points: number;
  status: string;
}

export interface SprintCapacity {
  sprintName: string;
  totalPoints: number;
  usedPoints: number;
  capacityPercent: number;
  tickets: SprintTicket[];
}

export interface SprintCheckResult {
  capacity: SprintCapacity;
  overThreshold: boolean;
  suggestions: string[];
}

// ── Mock data for when no integration is connected ──────────────────

const MOCK_SPRINT: SprintCapacity = {
  sprintName: 'Sprint 12',
  totalPoints: 40,
  usedPoints: 34,
  capacityPercent: 85,
  tickets: [
    { id: 'MOCK-101', title: 'Implement user profile page', points: 5, status: 'in_progress' },
    { id: 'MOCK-102', title: 'Fix login redirect bug', points: 3, status: 'done' },
    { id: 'MOCK-103', title: 'Add export CSV feature', points: 8, status: 'todo' },
    { id: 'MOCK-104', title: 'Update API rate limiting', points: 5, status: 'in_progress' },
    { id: 'MOCK-105', title: 'Refactor notification service', points: 8, status: 'todo' },
    { id: 'MOCK-106', title: 'Write integration tests', points: 5, status: 'in_progress' },
  ],
};

const CAPACITY_THRESHOLD = 80;

// In-memory set of deferred ticket keys (MVP — no persistence needed)
const deferredTickets = new Set<string>();

// ── Service ─────────────────────────────────────────────────────────

export const sprintService = {
  /**
   * Fetch current sprint capacity for a team.
   * Uses Jira integration if available, otherwise returns mock data.
   */
  async getSprintCapacity(_teamId: string): Promise<SprintCapacity> {
    // TODO: When Jira/Linear integration is connected, fetch real sprint data.
    // For MVP, return mock data that simulates a near-capacity sprint.
    const sprint = { ...MOCK_SPRINT };
    // Filter out deferred tickets
    sprint.tickets = sprint.tickets.filter((t) => !deferredTickets.has(t.id));
    sprint.usedPoints = sprint.tickets.reduce((sum, t) => sum + t.points, 0);
    sprint.capacityPercent = Math.round((sprint.usedPoints / sprint.totalPoints) * 100);
    return sprint;
  },

  /**
   * Check sprint capacity and return trade-off suggestions when over threshold.
   */
  async checkSprintCapacity(
    teamId: string,
    newTicketPoints?: number,
  ): Promise<SprintCheckResult> {
    const capacity = await this.getSprintCapacity(teamId);

    const projectedUsed = capacity.usedPoints + (newTicketPoints ?? 0);
    const projectedPercent = Math.round((projectedUsed / capacity.totalPoints) * 100);

    const overThreshold = projectedPercent >= CAPACITY_THRESHOLD;

    const suggestions: string[] = [];
    if (overThreshold) {
      // Suggest deferring non-started tickets with highest points first
      const deferrable = capacity.tickets
        .filter((t) => t.status === 'todo')
        .sort((a, b) => b.points - a.points);

      for (const ticket of deferrable) {
        suggestions.push(
          `Defer "${ticket.title}" (${ticket.id}, ${ticket.points} pts) to free capacity`,
        );
      }

      if (suggestions.length === 0) {
        suggestions.push(
          'All current tickets are in progress. Consider scheduling this spec for the next sprint.',
        );
      }
    }

    return { capacity, overThreshold, suggestions };
  },

  /**
   * Defer a ticket — marks it as moved to backlog.
   * In MVP this is tracked in-memory; with real integration it would
   * call the Jira/Linear API to move the ticket.
   */
  async deferTicket(_teamId: string, ticketKey: string): Promise<{ deferred: boolean }> {
    deferredTickets.add(ticketKey);
    return { deferred: true };
  },

  /** Reset deferred state (useful for testing) */
  _resetDeferred(): void {
    deferredTickets.clear();
  },
};
