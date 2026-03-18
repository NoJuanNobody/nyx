import Anthropic from '@anthropic-ai/sdk';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { documents, deliverables } from '../db/schema.js';
import { config } from '../lib/config.js';

const MODEL = 'claude-sonnet-4-20250514';

const client = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  : null;

// Maps each lifecycle stage to the deliverable types it should produce
const STAGE_DELIVERABLE_CONFIG: Record<string, string[]> = {
  // Software development lifecycle
  conception: ['markdown', 'ai_report'],
  definition: ['markdown', 'ai_report', 'structured_export'],
  architecture: ['markdown', 'ai_report', 'structured_export'],
  implementation: ['markdown', 'ai_report', 'structured_export'],
  execution: ['markdown', 'ai_report'],
  // Scientific writing
  research_notes: ['markdown', 'ai_report'],
  literature_review: ['markdown', 'ai_report'],
  draft_sections: ['markdown', 'ai_report'],
  peer_review: ['markdown', 'ai_report', 'structured_export'],
  revisions: ['markdown', 'ai_report'],
  final_paper: ['markdown', 'ai_report', 'structured_export'],
  // Marketing copy
  brief_strategy: ['markdown', 'ai_report'],
  draft_variations: ['markdown', 'ai_report'],
  ab_testing: ['markdown', 'structured_export'],
  refinement: ['markdown', 'ai_report'],
  final_version: ['markdown', 'ai_report', 'structured_export'],
  live: ['markdown', 'structured_export'],
  // Creative writing
  outline: ['markdown'],
  first_draft: ['markdown', 'ai_report'],
  revision_passes: ['markdown', 'ai_report'],
  feedback_integration: ['markdown', 'ai_report'],
  final_polish: ['markdown', 'ai_report'],
  publication_ready: ['markdown', 'ai_report', 'structured_export'],
  // Journalism
  story_pitch: ['markdown', 'ai_report'],
  research_reporting: ['markdown', 'structured_export'],
  draft_article: ['markdown', 'ai_report'],
  editorial_review: ['markdown', 'ai_report'],
  published: ['markdown', 'structured_export'],
  // Hardware design
  schematic_design: ['markdown', 'ai_report'],
  pcb_layout: ['markdown', 'structured_export'],
  prototyping: ['markdown', 'ai_report'],
  testing: ['markdown', 'structured_export'],
  manufacturing_prep: ['markdown', 'ai_report', 'structured_export'],
  final_specs: ['markdown', 'ai_report', 'structured_export'],
};

// Default deliverable types for any unlisted stage
const DEFAULT_DELIVERABLE_TYPES = ['markdown', 'ai_report'];

// Stage-aware prompts for AI report generation
const STAGE_REPORT_PROMPTS: Record<string, string> = {
  conception: 'Transform this document into a polished executive summary. Highlight the core problem, proposed solution, target audience, and business opportunity. Use professional language suitable for stakeholders.',
  definition: 'Convert this document into a formal Product Requirements Document (PRD). Structure it with: Overview, Goals & Success Metrics, User Stories with Acceptance Criteria, Scope & Out of Scope, and Open Questions.',
  architecture: 'Format this as a technical architecture decision record (ADR). Include: Context, Decisions Made, Consequences, Alternatives Considered, and Implementation Notes. Make it suitable for engineering review.',
  implementation: 'Reformat this into an actionable implementation brief. Include: Task Breakdown, File-by-File Changes, Test Plan, Acceptance Criteria, and Rollback Strategy. Optimize for AI coding agent consumption.',
  execution: 'Convert this into release documentation. Include: Release Summary, What Changed, Deployment Steps, Known Issues, and Monitoring Checklist.',
  final_paper: 'Format this as a polished academic-style report with Abstract, Introduction, Body, Conclusion, and References sections.',
  final_version: 'Transform this into publication-ready copy with clear headline, body copy, and call-to-action. Ensure tone is consistent and professional.',
  live: 'Generate a deployment summary with key messages, rollout notes, and success metrics for this content.',
  publication_ready: 'Format this as a final manuscript ready for publication. Include all necessary sections, consistent formatting, and a clean structure.',
};

const DEFAULT_REPORT_PROMPT = 'Transform this document into a polished, professional report suitable for stakeholder review. Improve structure, clarity, and completeness while preserving all key information.';

type DeliverableType = 'markdown' | 'ai_report' | 'structured_export';

function getDeliverableTypesForStage(stage: string): DeliverableType[] {
  const types = STAGE_DELIVERABLE_CONFIG[stage] ?? DEFAULT_DELIVERABLE_TYPES;
  return types as DeliverableType[];
}

async function generateMarkdown(
  doc: { id: string; title: string; content: string; stage: string | null },
): Promise<{ fileName: string; content: string; mimeType: string }> {
  const stage = doc.stage ?? 'draft';
  const header = `# ${doc.title}\n\n**Stage:** ${stage}\n**Generated:** ${new Date().toISOString()}\n\n---\n\n`;
  return {
    fileName: `${doc.title.toLowerCase().replace(/\s+/g, '-')}-${stage}.md`,
    content: header + doc.content,
    mimeType: 'text/markdown',
  };
}

async function generateStructuredExport(
  doc: { id: string; title: string; content: string; stage: string | null },
): Promise<{ fileName: string; content: string; mimeType: string }> {
  const stage = doc.stage ?? 'unknown';
  const structured = {
    id: doc.id,
    title: doc.title,
    stage,
    exportedAt: new Date().toISOString(),
    content: doc.content,
    wordCount: doc.content.split(/\s+/).filter(Boolean).length,
    sections: doc.content
      .split('\n')
      .filter((line) => line.startsWith('#'))
      .map((line) => line.replace(/^#+\s*/, '').trim()),
  };
  return {
    fileName: `${doc.title.toLowerCase().replace(/\s+/g, '-')}-${stage}.json`,
    content: JSON.stringify(structured, null, 2),
    mimeType: 'application/json',
  };
}

async function generateAIReport(
  doc: { id: string; title: string; content: string; stage: string | null },
): Promise<{ fileName: string; content: string; mimeType: string }> {
  if (!client) {
    throw new Error('ANTHROPIC_API_KEY is not configured — AI report generation unavailable.');
  }

  const stage = doc.stage ?? '';
  const prompt = STAGE_REPORT_PROMPTS[stage] ?? DEFAULT_REPORT_PROMPT;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: `You are a professional technical writer. ${prompt} Respond ONLY with the formatted document in markdown.`,
    messages: [
      {
        role: 'user',
        content: `Document title: ${doc.title}\n\nContent:\n\n${doc.content}`,
      },
    ],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('');

  return {
    fileName: `${doc.title.toLowerCase().replace(/\s+/g, '-')}-${stage}-report.md`,
    content: text,
    mimeType: 'text/markdown',
  };
}

export const deliverableService = {
  /**
   * Generate all deliverables for a document at its current stage.
   * Existing deliverables for the same document+stage are deleted first.
   */
  async generateDeliverables(documentId: string): Promise<typeof deliverables.$inferSelect[]> {
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId));

    if (!doc) throw new Error(`Document ${documentId} not found`);

    const stage = doc.stage ?? 'draft';
    const types = getDeliverableTypesForStage(stage);

    // Remove old deliverables for this document+stage
    await db
      .delete(deliverables)
      .where(and(eq(deliverables.documentId, documentId), eq(deliverables.stage, stage)));

    const results: typeof deliverables.$inferSelect[] = [];

    for (const type of types) {
      // Insert a "generating" placeholder
      const [placeholder] = await db
        .insert(deliverables)
        .values({
          documentId,
          stage,
          type,
          fileName: '',
          status: 'generating',
          mimeType: 'text/plain',
        })
        .returning();

      try {
        let generated: { fileName: string; content: string; mimeType: string };

        if (type === 'markdown') {
          generated = await generateMarkdown(doc);
        } else if (type === 'ai_report') {
          generated = await generateAIReport(doc);
        } else {
          generated = await generateStructuredExport(doc);
        }

        const [updated] = await db
          .update(deliverables)
          .set({
            fileName: generated.fileName,
            content: generated.content,
            mimeType: generated.mimeType,
            status: 'ready',
            generatedAt: new Date(),
          })
          .where(eq(deliverables.id, placeholder.id))
          .returning();

        results.push(updated);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const [updated] = await db
          .update(deliverables)
          .set({ status: 'failed', metadata: { error: errorMsg } })
          .where(eq(deliverables.id, placeholder.id))
          .returning();
        results.push(updated);
      }
    }

    return results;
  },

  async listDeliverables(documentId: string): Promise<typeof deliverables.$inferSelect[]> {
    return db
      .select()
      .from(deliverables)
      .where(eq(deliverables.documentId, documentId));
  },

  async getDeliverable(id: string): Promise<typeof deliverables.$inferSelect | null> {
    const [row] = await db
      .select()
      .from(deliverables)
      .where(eq(deliverables.id, id));
    return row ?? null;
  },

  async deleteDeliverable(id: string): Promise<boolean> {
    const result = await db
      .delete(deliverables)
      .where(eq(deliverables.id, id))
      .returning();
    return result.length > 0;
  },

  getTypesForStage(stage: string): DeliverableType[] {
    return getDeliverableTypesForStage(stage);
  },
};
