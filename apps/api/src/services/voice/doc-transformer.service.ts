import type { MeetingIntelligence } from '@nyx/shared';
import { db } from '../../db/index.js';
import { documents, meetingDocuments } from '../../db/schema.js';

export interface TransformedDocument {
  title: string;
  content: string;
}

/**
 * Convert MeetingIntelligence into a Nyx-formatted markdown document.
 */
export function transformToDocument(intelligence: MeetingIntelligence): TransformedDocument {
  const date = intelligence.createdAt
    ? new Date(intelligence.createdAt).toLocaleString()
    : 'Unknown Date';

  const sections: string[] = [];

  sections.push(`# Meeting Notes: ${date}`);

  // Summary
  sections.push(`## Summary\n\n${intelligence.summary || '_No summary available._'}`);

  // Decisions
  if (intelligence.decisions.length > 0) {
    const items = intelligence.decisions
      .map((d) => {
        const parts = [`- ${d.text}`];
        if (d.madeBy) parts[0] += ` _(by ${d.madeBy})_`;
        return parts[0];
      })
      .join('\n');
    sections.push(`## Decisions\n\n${items}`);
  } else {
    sections.push('## Decisions\n\n_No decisions recorded._');
  }

  // Action Items
  if (intelligence.actionItems.length > 0) {
    const items = intelligence.actionItems
      .map((a) => {
        const checked = a.status === 'done' ? 'x' : ' ';
        let line = `- [${checked}] ${a.text}`;
        const meta: string[] = [];
        if (a.assignee) meta.push(`assignee: ${a.assignee}`);
        if (a.deadline) meta.push(`deadline: ${a.deadline}`);
        if (a.priority) meta.push(`priority: ${a.priority}`);
        if (meta.length > 0) line += ` _(${meta.join(', ')})_`;
        return line;
      })
      .join('\n');
    sections.push(`## Action Items\n\n${items}`);
  } else {
    sections.push('## Action Items\n\n_No action items recorded._');
  }

  // Code References
  if (intelligence.codeReferences.length > 0) {
    const items = intelligence.codeReferences
      .map((c) => {
        const parts: string[] = [];
        if (c.filePath) parts.push(`\`${c.filePath}\``);
        if (c.symbol) parts.push(`symbol: \`${c.symbol}\``);
        if (c.repository) parts.push(`repo: ${c.repository}`);
        if (c.context) parts.push(c.context);
        return `- ${parts.join(' — ') || '_unnamed reference_'}`;
      })
      .join('\n');
    sections.push(`## Code References\n\n${items}`);
  } else {
    sections.push('## Code References\n\n_No code references recorded._');
  }

  // Open Questions
  if (intelligence.openQuestions.length > 0) {
    const items = intelligence.openQuestions
      .map((q) => {
        let line = `- ${q.text}`;
        if (q.raisedBy) line += ` _(raised by ${q.raisedBy})_`;
        if (q.resolved) line += ' **[RESOLVED]**';
        return line;
      })
      .join('\n');
    sections.push(`## Open Questions\n\n${items}`);
  } else {
    sections.push('## Open Questions\n\n_No open questions recorded._');
  }

  // Participants
  if (intelligence.participants.length > 0) {
    const items = intelligence.participants.map((p) => `- ${p}`).join('\n');
    sections.push(`## Participants\n\n${items}`);
  } else {
    sections.push('## Participants\n\n_No participants recorded._');
  }

  return {
    title: `Meeting Notes: ${date}`,
    content: sections.join('\n\n'),
  };
}

/**
 * Create a Nyx document from MeetingIntelligence and persist it.
 * Returns the new document ID.
 */
export async function createMeetingDocument(
  intelligence: MeetingIntelligence,
  teamId: string,
  createdById: string,
  platform = 'unknown',
): Promise<string> {
  const { title, content } = transformToDocument(intelligence);

  const [doc] = await db
    .insert(documents)
    .values({
      title,
      content,
      teamId,
      createdById,
      stage: 'definition',
    })
    .returning();

  await db.insert(meetingDocuments).values({
    documentId: doc.id,
    meetingSessionId: intelligence.sessionId,
    platform,
    meetingIntelligence: intelligence,
    duration: intelligence.duration ?? null,
    participants: intelligence.participants ?? [],
  });

  return doc.id;
}

export const docTransformerService = {
  transformToDocument,
  createMeetingDocument,
};
