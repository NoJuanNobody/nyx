// Sprint capacity service: fetches active sprint data from Jira/Linear,
// checks capacity, and supports deferring tickets to backlog.
//
// Capacity is measured in DECISION WEIGHT — the human judgment cost to
// review, validate, and integrate work — not story points or dev-days.
// See issue #145 for the rationale behind this model.

export interface SprintTicket {
  id: string;
  title: string;
  points: number;
  /** Decision weight: human judgment cost derived from the backing spec (1–100) */
  decisionWeight: number;
  /** Estimated review cycles needed before this is shippable */
  reviewCycles: number;
  status: string;
}

export interface SprintCapacity {
  sprintName: string;
  /** Total decision weight the team can absorb per sprint */
  totalWeight: number;
  /** Sum of decision weight for all tickets in the sprint */
  usedWeight: number;
  /** Percentage of decision weight capacity consumed */
  capacityPercent: number;
  /** Legacy story points — kept for transition, not used for gating */
  totalPoints: number;
  usedPoints: number;
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
  totalWeight: 200,
  usedWeight: 168,
  capacityPercent: 84,
  totalPoints: 40,
  usedPoints: 34,
  tickets: [
    { id: 'MOCK-101', title: 'Implement user profile page', points: 5, decisionWeight: 28, reviewCycles: 2, status: 'in_progress' },
    { id: 'MOCK-102', title: 'Fix login redirect bug', points: 3, decisionWeight: 12, reviewCycles: 1, status: 'done' },
    { id: 'MOCK-103', title: 'Add export CSV feature', points: 8, decisionWeight: 42, reviewCycles: 3, status: 'todo' },
    { id: 'MOCK-104', title: 'Update API rate limiting', points: 5, decisionWeight: 35, reviewCycles: 2, status: 'in_progress' },
    { id: 'MOCK-105', title: 'Refactor notification service', points: 8, decisionWeight: 22, reviewCycles: 2, status: 'todo' },
    { id: 'MOCK-106', title: 'Write integration tests', points: 5, decisionWeight: 29, reviewCycles: 2, status: 'in_progress' },
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
    sprint.usedWeight = sprint.tickets.reduce((sum, t) => sum + t.decisionWeight, 0);
    // Capacity is gated on decision weight, not story points
    sprint.capacityPercent = Math.round((sprint.usedWeight / sprint.totalWeight) * 100);
    return sprint;
  },

  /**
   * Check sprint capacity and return trade-off suggestions when over threshold.
   */
  async checkSprintCapacity(
    teamId: string,
    newTicketPoints?: number,
    newTicketWeight?: number,
  ): Promise<SprintCheckResult> {
    const capacity = await this.getSprintCapacity(teamId);

    const addedWeight = newTicketWeight ?? (newTicketPoints ? newTicketPoints * 5 : 0);
    const projectedWeight = capacity.usedWeight + addedWeight;
    const projectedPercent = Math.round((projectedWeight / capacity.totalWeight) * 100);

    const overThreshold = projectedPercent >= CAPACITY_THRESHOLD;

    const suggestions: string[] = [];
    if (overThreshold) {
      // Suggest deferring non-started tickets with highest decision weight first
      const deferrable = capacity.tickets
        .filter((t) => t.status === 'todo')
        .sort((a, b) => b.decisionWeight - a.decisionWeight);

      for (const ticket of deferrable) {
        suggestions.push(
          `Defer "${ticket.title}" (${ticket.id}, weight ${ticket.decisionWeight}, ~${ticket.reviewCycles} review cycles) to free judgment bandwidth`,
        );
      }

      if (suggestions.length === 0) {
        suggestions.push(
          'All current tickets are in progress. The team\'s review bandwidth is saturated — adding more work will degrade review quality.',
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
