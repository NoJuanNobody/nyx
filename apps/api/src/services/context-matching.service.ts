import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db/index.js';
import { documents } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { config } from '../lib/config.js';

const MODEL = 'claude-sonnet-4-6';

const client = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  : null;

function requireClient(): Anthropic {
  if (!client) {
    throw new Error('ANTHROPIC_API_KEY is not configured. AI features require a valid API key.');
  }
  return client;
}

export interface ContextMatch {
  documentId: string;
  title: string;
  relevance: 'high' | 'medium' | 'low';
  relationship: 'confirms' | 'contradicts' | 'expands';
  summary: string;
}

export interface ContextSignal {
  type: 'recurring_pattern' | 'contradiction' | 'scope_creep';
  description: string;
  relatedDocIds: string[];
}

export interface ContextMatchResult {
  matches: ContextMatch[];
  signals: ContextSignal[];
}

export const contextMatchingService = {
  async findRelatedSpecs(newInput: string, teamId: string): Promise<ContextMatchResult> {
    const ai = requireClient();

    // Fetch recent documents for the team
    const teamDocs = await db
      .select({
        id: documents.id,
        title: documents.title,
        content: documents.content,
      })
      .from(documents)
      .where(eq(documents.teamId, teamId));

    if (teamDocs.length === 0) {
      return { matches: [], signals: [] };
    }

    // Build a summary of existing documents for the AI prompt
    const docSummaries = teamDocs
      .map(
        (doc, idx) =>
          `[Doc ${idx + 1}] id="${doc.id}" title="${doc.title}"\n${doc.content.slice(0, 1500)}`,
      )
      .join('\n\n---\n\n');

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: `You are a spec history analyst for a product documentation platform. Given a new input and a set of existing documents, analyze semantic similarity and relationships.

For each related document, classify the relationship:
- "confirms": the new input reinforces or aligns with an existing spec
- "contradicts": the new input conflicts with an existing spec
- "expands": the new input extends scope beyond what an existing spec covers

Also detect cross-cutting signals:
- "recurring_pattern": the same idea or requirement has appeared multiple times
- "contradiction": conflicting requirements exist across specs
- "scope_creep": the new input significantly expands the project beyond existing boundaries

Respond ONLY with valid JSON in this exact format:
{
  "matches": [
    {
      "documentId": "<exact doc id>",
      "title": "<doc title>",
      "relevance": "high" | "medium" | "low",
      "relationship": "confirms" | "contradicts" | "expands",
      "summary": "<brief explanation of the relationship>"
    }
  ],
  "signals": [
    {
      "type": "recurring_pattern" | "contradiction" | "scope_creep",
      "description": "<explanation>",
      "relatedDocIds": ["<doc id 1>", "<doc id 2>"]
    }
  ]
}

Only include documents with meaningful relevance. Omit irrelevant documents.`,
      messages: [
        {
          role: 'user',
          content: `## New Input\n${newInput}\n\n## Existing Documents\n${docSummaries}`,
        },
      ],
    });

    let text = response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip code fences
    text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

    // Try to extract JSON
    const jsonMatch = text.match(/\{[\s\S]*"matches"\s*:[\s\S]*\}/);
    const jsonCandidate = jsonMatch ? jsonMatch[0] : text;

    try {
      const parsed = JSON.parse(jsonCandidate) as ContextMatchResult;

      // Validate and normalize the response
      const validDocIds = new Set(teamDocs.map((d) => d.id));

      const matches = Array.isArray(parsed.matches)
        ? parsed.matches.filter(
            (m) =>
              validDocIds.has(m.documentId) &&
              ['high', 'medium', 'low'].includes(m.relevance) &&
              ['confirms', 'contradicts', 'expands'].includes(m.relationship),
          )
        : [];

      const signals = Array.isArray(parsed.signals)
        ? parsed.signals.filter(
            (s) =>
              ['recurring_pattern', 'contradiction', 'scope_creep'].includes(s.type) &&
              Array.isArray(s.relatedDocIds),
          )
        : [];

      return { matches, signals };
    } catch {
      return { matches: [], signals: [] };
    }
  },
};
