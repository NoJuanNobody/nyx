// Sprint capacity service: fetches sprint data from GitHub Projects v2,
// checks capacity, and supports deferring tickets.
//
// Capacity is measured in DECISION WEIGHT — the human judgment cost to
// review, validate, and integrate work — not story points or dev-days.
// See issue #145 for the rationale behind this model.

import { githubService } from './github.service.js';
import { jiraService } from './jira.service.js';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { integrations } from '../db/schema.js';

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
  /** Source of data: 'github', 'jira', or 'none' (no integration connected) */
  source: 'github' | 'jira' | 'none';
}

export interface SprintCheckResult {
  capacity: SprintCapacity;
  overThreshold: boolean;
  suggestions: string[];
}

// ── Status mapping ──────────────────────────────────────────────────
// GitHub Projects v2 status columns → normalized status values

function normalizeStatus(ghStatus: string | null): string {
  if (!ghStatus) return 'todo';
  const lower = ghStatus.toLowerCase();
  if (lower === 'done' || lower === 'closed' || lower === 'merged' || lower === 'complete') return 'done';
  if (lower === 'in progress' || lower === 'in review' || lower === 'active') return 'in_progress';
  return 'todo'; // Todo, Backlog, New, Triage, etc.
}

// ── Decision weight heuristic ───────────────────────────────────────
// Estimate decision weight from issue labels and title when no explicit
// weight field is present. This is a rough heuristic — teams can
// override by adding a custom "Weight" field to their GitHub Project.

function estimateDecisionWeight(title: string, labels: string[]): number {
  let weight = 15; // baseline

  // Label-based adjustments
  for (const label of labels) {
    const l = label.toLowerCase();
    if (l.includes('bug') || l.includes('fix')) weight += 5;
    if (l.includes('feature') || l.includes('enhancement')) weight += 12;
    if (l.includes('security') || l.includes('auth')) weight += 15;
    if (l.includes('refactor') || l.includes('chore')) weight -= 5;
    if (l.includes('docs') || l.includes('documentation')) weight -= 8;
    if (l.includes('critical') || l.includes('urgent')) weight += 10;
    if (l.includes('good first issue') || l.includes('easy')) weight -= 10;
  }

  // Title-based adjustments
  const t = title.toLowerCase();
  if (t.includes('migration') || t.includes('breaking')) weight += 15;
  if (t.includes('api') || t.includes('endpoint')) weight += 5;
  if (t.includes('test') || t.includes('e2e')) weight += 3;

  return Math.max(5, Math.min(weight, 80)); // clamp 5–80
}

function estimateReviewCycles(weight: number): number {
  if (weight >= 40) return 3;
  if (weight >= 25) return 2;
  return 1;
}

// ── Default team capacity ───────────────────────────────────────────

const DEFAULT_TOTAL_WEIGHT = 200;
const CAPACITY_THRESHOLD = 80;

// In-memory set of deferred item IDs
const deferredItems = new Set<string>();

// Cache project data + context for status updates
let cachedProjectContext: {
  projectId: string;
  statusFieldId: string;
  doneOptionId: string | null;
  backlogOptionId: string | null;
} | null = null;

// ── GitHub integration helpers ──────────────────────────────────────

async function getGitHubIntegration(teamId: string) {
  const [integration] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.teamId, teamId), eq(integrations.type, 'github')));

  if (!integration) return null;

  const config = integration.config as {
    accessToken?: string;
    selectedRepos?: Array<{ owner: string; name: string; fullName: string }>;
  };

  if (!config.accessToken) return null;

  return { token: config.accessToken, repos: config.selectedRepos ?? [] };
}

async function fetchFromGitHub(teamId: string): Promise<SprintCapacity | null> {
  const gh = await getGitHubIntegration(teamId);
  if (!gh || gh.repos.length === 0) return null;

  const owner = gh.repos[0].owner;

  try {
    // Find a project board for this owner
    const projects = await githubService.listProjects(gh.token, owner);
    if (projects.length === 0) return null;

    // Use the most recently updated project
    const project = projects[0];
    const projectData = await githubService.getProjectItems(gh.token, project.id);

    // Cache project context for status mutations
    const doneOption = projectData.statusField?.options.find(
      (o) => normalizeStatus(o.name) === 'done',
    );
    const backlogOption = projectData.statusField?.options.find(
      (o) => o.name.toLowerCase().includes('backlog'),
    );
    cachedProjectContext = {
      projectId: project.id,
      statusFieldId: projectData.statusField?.id ?? '',
      doneOptionId: doneOption?.id ?? null,
      backlogOptionId: backlogOption?.id ?? null,
    };

    // Convert project items to sprint tickets
    const tickets: SprintTicket[] = projectData.items
      .filter((item) => !deferredItems.has(item.id))
      .map((item) => {
        const status = normalizeStatus(item.status);
        const weight = estimateDecisionWeight(item.title, item.labels);
        return {
          id: `#${item.number}`,
          title: item.title,
          points: 1, // not used for gating
          decisionWeight: weight,
          reviewCycles: estimateReviewCycles(weight),
          status,
        };
      });

    const usedWeight = tickets.reduce((sum, t) => sum + t.decisionWeight, 0);
    const usedPoints = tickets.reduce((sum, t) => sum + t.points, 0);

    return {
      sprintName: projectData.title,
      totalWeight: DEFAULT_TOTAL_WEIGHT,
      usedWeight,
      capacityPercent: Math.round((usedWeight / DEFAULT_TOTAL_WEIGHT) * 100),
      totalPoints: tickets.length,
      usedPoints,
      tickets,
      source: 'github',
    };
  } catch (err) {
    console.warn('[sprint] GitHub Projects fetch failed, falling back to mock:', err);
    return null;
  }
}

// ── Jira integration helpers ────────────────────────────────────────

async function getJiraIntegration(teamId: string) {
  const [integration] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.teamId, teamId), eq(integrations.type, 'jira')));

  if (!integration) return null;

  const config = integration.config as {
    baseUrl?: string;
    email?: string;
    apiToken?: string;
    projectKey?: string;
  };

  if (!config.baseUrl || !config.email || !config.apiToken) return null;

  return config as { baseUrl: string; email: string; apiToken: string; projectKey?: string };
}

function normalizeJiraStatus(statusName: string): string {
  const lower = statusName.toLowerCase();
  if (lower === 'done' || lower === 'closed' || lower === 'resolved') return 'done';
  if (lower === 'in progress' || lower === 'in review') return 'in_progress';
  return 'todo';
}

async function fetchFromJira(teamId: string): Promise<SprintCapacity | null> {
  const jira = await getJiraIntegration(teamId);
  if (!jira) return null;

  try {
    const issues = await jiraService.searchIssues(
      jira.baseUrl,
      jira.email,
      jira.apiToken,
      jira.projectKey,
    );

    const tickets: SprintTicket[] = issues
      .filter((issue) => !deferredItems.has(issue.key))
      .map((issue) => {
        const status = normalizeJiraStatus(issue.fields.status.name);
        const labels: string[] = [];
        const weight = estimateDecisionWeight(issue.fields.summary, labels);
        return {
          id: issue.key,
          title: issue.fields.summary,
          points: 1,
          decisionWeight: weight,
          reviewCycles: estimateReviewCycles(weight),
          status,
        };
      });

    const usedWeight = tickets.reduce((sum, t) => sum + t.decisionWeight, 0);
    const usedPoints = tickets.reduce((sum, t) => sum + t.points, 0);

    return {
      sprintName: jira.projectKey ? `${jira.projectKey} Sprint` : 'Jira Sprint',
      totalWeight: DEFAULT_TOTAL_WEIGHT,
      usedWeight,
      capacityPercent: Math.round((usedWeight / DEFAULT_TOTAL_WEIGHT) * 100),
      totalPoints: tickets.length,
      usedPoints,
      tickets,
      source: 'jira',
    };
  } catch (err) {
    console.warn('[sprint] Jira fetch failed:', err);
    return null;
  }
}

// ── Empty fallback (no integration connected) ───────────────────────

function getEmptySprint(): SprintCapacity {
  return {
    sprintName: 'No Sprint',
    totalWeight: DEFAULT_TOTAL_WEIGHT,
    usedWeight: 0,
    capacityPercent: 0,
    totalPoints: 0,
    usedPoints: 0,
    tickets: [],
    source: 'none',
  };
}

// ── Service ─────────────────────────────────────────────────────────

export const sprintService = {
  /**
   * Fetch current sprint capacity for a team.
   * Pulls from GitHub Projects v2 if connected, then tries Jira.
   * Returns an empty sprint when no integration is available.
   */
  async getSprintCapacity(teamId: string): Promise<SprintCapacity> {
    const ghData = await fetchFromGitHub(teamId);
    if (ghData) return ghData;

    const jiraData = await fetchFromJira(teamId);
    if (jiraData) return jiraData;

    return getEmptySprint();
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
   * With GitHub integration, moves the item to Backlog column if available.
   */
  async deferTicket(teamId: string, ticketKey: string): Promise<{ deferred: boolean }> {
    deferredItems.add(ticketKey);

    // Attempt to move in GitHub Projects if we have context
    if (cachedProjectContext?.backlogOptionId && cachedProjectContext.statusFieldId) {
      try {
        const gh = await getGitHubIntegration(teamId);
        if (gh) {
          await githubService.updateProjectItemStatus(
            gh.token,
            cachedProjectContext.projectId,
            ticketKey,
            cachedProjectContext.statusFieldId,
            cachedProjectContext.backlogOptionId,
          );
        }
      } catch {
        // Non-fatal — local defer still works
      }
    }

    return { deferred: true };
  },

  /**
   * Schedule deferred tickets for the next sprint.
   */
  async scheduleForNextSprint(_teamId: string, ticketKeys: string[]): Promise<{ scheduled: string[] }> {
    for (const key of ticketKeys) {
      deferredItems.delete(key);
    }
    return { scheduled: ticketKeys };
  },

  /** Reset deferred state (useful for testing) */
  _resetDeferred(): void {
    deferredItems.clear();
    cachedProjectContext = null;
  },
};
