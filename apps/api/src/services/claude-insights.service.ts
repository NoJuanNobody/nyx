// claude-insights.service.ts
// Fetches Claude GitHub Action comments from GitHub issues and parses them
// into structured insight records stored on the ticket.

import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tickets, integrations, documents } from '../db/schema.js';

export interface ClaudeInsight {
  title: string;
  summary: string[];
  filesChanged: string[];
  commentId: number;
  commentUrl: string;
  commentedAt: string;
  fetchedAt: string;
}

interface GitHubComment {
  id: number;
  html_url: string;
  body: string;
  created_at: string;
  user: {
    login: string;
    type: string;
  };
}

// Bot usernames that Claude GitHub Action posts as
const CLAUDE_BOT_LOGINS = new Set([
  'github-actions[bot]',
  'claude[bot]',
  'claude-code[bot]',
  'anthropic-claude[bot]',
]);

function isClaudeComment(comment: GitHubComment): boolean {
  const login = comment.user?.login?.toLowerCase() ?? '';
  if (CLAUDE_BOT_LOGINS.has(login)) return true;
  // Also match any bot whose login contains 'claude'
  if (comment.user?.type === 'Bot' && login.includes('claude')) return true;
  return false;
}

/**
 * Parse a Claude bot markdown comment into structured sections.
 * Claude comments typically follow this pattern:
 *
 *   ## Title
 *   Summary sentence or bullets
 *   ### Files changed
 *   - path/to/file.ts
 */
export function parseClaudeComment(body: string): Pick<ClaudeInsight, 'title' | 'summary' | 'filesChanged'> {
  const lines = body.split('\n');

  let title = '';
  const summary: string[] = [];
  const filesChanged: string[] = [];

  let section: 'header' | 'summary' | 'files' | 'other' = 'header';

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) continue;

    // Heading lines
    if (line.startsWith('#')) {
      const text = line.replace(/^#+\s*/, '').trim();
      if (section === 'header' && !title) {
        title = text;
        section = 'summary';
        continue;
      }
      const lower = text.toLowerCase();
      if (lower.includes('file') || lower.includes('change') || lower.includes('modified')) {
        section = 'files';
      } else if (lower.includes('summary') || lower.includes('overview') || lower.includes('what')) {
        section = 'summary';
      } else {
        section = 'other';
      }
      continue;
    }

    // Bullet points
    const bulletMatch = line.match(/^[-*+]\s+(.+)/);
    if (bulletMatch) {
      const text = bulletMatch[1].trim();
      if (section === 'files') {
        // Strip markdown formatting from file paths
        const filePath = text.replace(/`/g, '').trim();
        filesChanged.push(filePath);
      } else if (section === 'summary' || section === 'other') {
        summary.push(text);
      }
      continue;
    }

    // Plain paragraph text in summary section
    if (section === 'summary' && line.length > 0 && !line.startsWith('|')) {
      // Avoid adding table rows and code fence markers
      if (!line.startsWith('```') && !line.startsWith('|')) {
        summary.push(line);
      }
    }
  }

  // Fallback: if no title was parsed, use first non-empty line
  if (!title) {
    title = lines.find((l) => l.trim().length > 0)?.trim() ?? 'Claude Action';
  }

  return { title, summary: summary.slice(0, 10), filesChanged: filesChanged.slice(0, 20) };
}

async function fetchIssueComments(
  accessToken: string,
  owner: string,
  repo: string,
  issueNumber: string,
): Promise<GitHubComment[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) return [];
  return res.json() as Promise<GitHubComment[]>;
}

export const claudeInsightsService = {
  /**
   * Fetch the latest Claude bot comment for the given ticket's GitHub issue,
   * parse it, store it on the ticket, and return the insight.
   * Returns null if no Claude comment found or not a GitHub ticket.
   */
  async refreshForTicket(ticketId: string): Promise<ClaudeInsight | null> {
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
    if (!ticket) throw new Error('Ticket not found');
    if (ticket.provider !== 'github') return null;

    // Derive team from document
    const [doc] = await db
      .select({ teamId: documents.teamId })
      .from(documents)
      .where(eq(documents.id, ticket.documentId));
    if (!doc) return null;

    const [integration] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.type, 'github'), eq(integrations.teamId, doc.teamId)));
    if (!integration) return null;

    const cfg = integration.config as {
      accessToken?: string;
      selectedRepos?: Array<{ owner: string; name: string }>;
      owner?: string;
      repo?: string;
    };
    const accessToken = cfg.accessToken;
    const owner = cfg.selectedRepos?.[0]?.owner ?? cfg.owner;
    const repo = cfg.selectedRepos?.[0]?.name ?? cfg.repo;

    if (!accessToken || !owner || !repo) return null;

    const comments = await fetchIssueComments(accessToken, owner, repo, ticket.externalId);
    const claudeComments = comments.filter(isClaudeComment);
    if (claudeComments.length === 0) return null;

    // Use the most recent Claude comment
    const latest = claudeComments[claudeComments.length - 1];
    const parsed = parseClaudeComment(latest.body ?? '');

    const insight: ClaudeInsight = {
      ...parsed,
      commentId: latest.id,
      commentUrl: latest.html_url,
      commentedAt: latest.created_at,
      fetchedAt: new Date().toISOString(),
    };

    await db
      .update(tickets)
      .set({ claudeInsights: insight, updatedAt: new Date() })
      .where(eq(tickets.id, ticketId));

    return insight;
  },

  /**
   * Return the currently stored insight for a ticket without re-fetching.
   */
  async getForTicket(ticketId: string): Promise<ClaudeInsight | null> {
    const [ticket] = await db
      .select({ claudeInsights: tickets.claudeInsights })
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    if (!ticket) throw new Error('Ticket not found');
    return (ticket.claudeInsights as ClaudeInsight | null) ?? null;
  },

  /**
   * Store an insight parsed externally (e.g., from webhook).
   */
  async storeForTicket(ticketId: string, insight: ClaudeInsight): Promise<void> {
    await db
      .update(tickets)
      .set({ claudeInsights: insight, updatedAt: new Date() })
      .where(eq(tickets.id, ticketId));
  },

  /**
   * Find tickets by GitHub issue number + repo and update their insight.
   * Used by the webhook handler when Claude posts a new comment.
   */
  async handleIssueCommentWebhook(
    owner: string,
    repo: string,
    issueNumber: number,
    comment: { id: number; html_url: string; body: string; created_at: string; user: { login: string; type: string } },
  ): Promise<void> {
    if (!isClaudeComment(comment)) return;

    // Find tickets matching this issue
    const externalId = String(issueNumber);
    const repoFullName = `${owner}/${repo}`.toLowerCase();

    const allTickets = await db
      .select({ id: tickets.id, externalId: tickets.externalId, documentId: tickets.documentId })
      .from(tickets)
      .where(eq(tickets.provider, 'github'));

    for (const ticket of allTickets) {
      if (ticket.externalId !== externalId) continue;

      // Verify this ticket belongs to the repo via its integration
      const [doc] = await db
        .select({ teamId: documents.teamId })
        .from(documents)
        .where(eq(documents.id, ticket.documentId));
      if (!doc) continue;

      const [integration] = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.type, 'github'), eq(integrations.teamId, doc.teamId)));
      if (!integration) continue;

      const cfg = integration.config as { selectedRepos?: Array<{ fullName: string }> };
      const hasRepo = cfg.selectedRepos?.some((r) => r.fullName.toLowerCase() === repoFullName);
      if (!hasRepo) continue;

      const parsed = parseClaudeComment(comment.body ?? '');
      const insight: ClaudeInsight = {
        ...parsed,
        commentId: comment.id,
        commentUrl: comment.html_url,
        commentedAt: comment.created_at,
        fetchedAt: new Date().toISOString(),
      };

      await this.storeForTicket(ticket.id, insight);
    }
  },

  parseClaudeComment,
  isClaudeComment,
};
