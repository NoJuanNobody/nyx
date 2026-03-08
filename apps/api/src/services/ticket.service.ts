// Ticket service: create tickets from documents, list, sync status

import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tickets, integrations, documents } from '../db/schema.js';
import { githubService } from './github.service.js';
import { jiraService } from './jira.service.js';
import { auditService } from './audit.service.js';

export const ticketService = {
  async createFromDocument(
    documentId: string,
    provider: 'github' | 'jira',
    title: string,
    body: string,
    createdById: string,
  ) {
    // Derive teamId from document
    const [doc] = await db
      .select({ teamId: documents.teamId })
      .from(documents)
      .where(eq(documents.id, documentId));

    if (!doc) throw new Error('Document not found');

    // Find integration scoped to team
    const [integration] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.type, provider), eq(integrations.teamId, doc.teamId)));

    if (!integration) {
      throw new Error(`No ${provider} integration configured for this team`);
    }

    let externalId: string;
    let externalUrl: string;

    if (provider === 'github') {
      const { accessToken, owner, repo } = integration.config as {
        accessToken: string;
        owner: string;
        repo: string;
      };
      const issue = await githubService.createIssue(accessToken, owner, repo, title, body);
      externalId = String(issue.number);
      externalUrl = issue.html_url;
    } else {
      const { baseUrl, email, apiToken, projectKey } = integration.config as {
        baseUrl: string;
        email: string;
        apiToken: string;
        projectKey: string;
      };
      const issue = await jiraService.createIssue(baseUrl, email, apiToken, {
        projectKey,
        summary: title,
        description: body,
      });
      externalId = issue.key;
      externalUrl = `${baseUrl}/browse/${issue.key}`;
    }

    const [ticket] = await db
      .insert(tickets)
      .values({
        documentId,
        provider,
        externalId,
        externalUrl,
        title,
        status: 'open',
        createdById,
      })
      .returning();

    // Fire-and-forget audit event
    setImmediate(async () => {
      try {
        await auditService.recordEvent({
          teamId: doc.teamId,
          eventType: 'ticket_created',
          actorId: createdById,
          documentId,
          ticketId: ticket.id,
          metadata: { provider, title, externalUrl },
        });
      } catch {}
    });

    return ticket;
  },

  async listByDocument(documentId: string) {
    return db.select().from(tickets).where(eq(tickets.documentId, documentId));
  },

  async syncStatus(ticketId: string) {
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId));

    if (!ticket) {
      throw new Error('Ticket not found');
    }

    // Derive teamId from the ticket's document
    const [doc] = await db
      .select({ teamId: documents.teamId })
      .from(documents)
      .where(eq(documents.id, ticket.documentId));

    if (!doc) throw new Error('Document not found for ticket');

    let newStatus: 'open' | 'in_progress' | 'closed' = ticket.status;

    if (ticket.provider === 'github') {
      const [integration] = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.type, 'github'), eq(integrations.teamId, doc.teamId)));

      if (integration) {
        const config = integration.config as { accessToken?: string; owner?: string; repo?: string };
        if (config.accessToken && config.owner && config.repo) {
          const res = await fetch(
            `https://api.github.com/repos/${config.owner}/${config.repo}/issues/${ticket.externalId}`,
            {
              headers: {
                Authorization: `Bearer ${config.accessToken}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
              },
            },
          );
          if (res.ok) {
            const data = (await res.json()) as { state: string };
            newStatus = data.state === 'closed' ? 'closed' : 'open';
          }
        }
      }
    } else if (ticket.provider === 'jira') {
      const [integration] = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.type, 'jira'), eq(integrations.teamId, doc.teamId)));

      if (integration) {
        const config = integration.config as { baseUrl?: string; email?: string; apiToken?: string };
        if (config.baseUrl && config.email && config.apiToken) {
          const issue = await jiraService.getIssue(
            config.baseUrl,
            config.email,
            config.apiToken,
            ticket.externalId,
          );
          const statusName = issue.fields.status.name.toLowerCase();
          if (statusName === 'done' || statusName === 'closed' || statusName === 'resolved') {
            newStatus = 'closed';
          } else if (statusName === 'in progress') {
            newStatus = 'in_progress';
          } else {
            newStatus = 'open';
          }
        }
      }
    }

    const [updated] = await db
      .update(tickets)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(tickets.id, ticketId))
      .returning();

    return updated;
  },
};
