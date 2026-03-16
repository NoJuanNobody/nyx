import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../lib/config.js';
import type { ParsedIntelligence } from '@nyx/shared';

const MODEL = 'claude-sonnet-4-20250514';

const client = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  : null;

function requireClient(): Anthropic {
  if (!client) {
    throw new Error(
      'ANTHROPIC_API_KEY is not configured. Semantic parsing requires a valid API key.',
    );
  }
  return client;
}

const EXTRACTION_PROMPT = `You are a meeting intelligence extraction engine. Given a meeting transcript, extract structured information.

Return ONLY valid JSON matching this exact schema:
{
  "decisions": [{ "id": "d-1", "text": "...", "madeBy": "...", "context": "...", "timestampMs": null }],
  "actionItems": [{ "id": "a-1", "text": "...", "assignee": "...", "deadline": null, "priority": "medium", "status": "pending" }],
  "codeReferences": [{ "id": "c-1", "filePath": "...", "symbol": "...", "repository": "...", "context": "...", "timestampMs": null }],
  "openQuestions": [{ "id": "q-1", "text": "...", "raisedBy": "...", "context": "...", "resolved": false, "timestampMs": null }],
  "summary": "A concise 2-3 sentence summary of the meeting.",
  "participants": ["Name1", "Name2"]
}

Rules:
- Generate unique IDs with prefixes: d- for decisions, a- for action items, c- for code references, q- for questions
- Extract code references from mentions of files, functions, classes, repos, PRs, commits
- Mark action items as "pending" status by default
- Infer priority from urgency cues: "ASAP", "blocker", "critical" = high; "nice to have", "eventually" = low; otherwise medium
- If no items found for a category, return an empty array
- Handle crosstalk and interruptions — extract the intended meaning
- Handle technical jargon — preserve exact terms used`;

function stripCodeFences(text: string): string {
  return text
    .replace(/```(?:json)?\s*\n?/g, '')
    .replace(/\n?\s*```/g, '')
    .trim();
}

function emptyResult(): ParsedIntelligence {
  return {
    decisions: [],
    actionItems: [],
    codeReferences: [],
    openQuestions: [],
    summary: '',
    participants: [],
  };
}

export const semanticParserService = {
  /**
   * Parse a meeting transcript through the AI to extract structured intelligence.
   * Returns decisions, action items, code references, open questions, summary, and participants.
   */
  async parseTranscript(transcript: string): Promise<ParsedIntelligence> {
    if (!transcript.trim()) {
      return emptyResult();
    }

    const ai = requireClient();

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: EXTRACTION_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Extract meeting intelligence from this transcript:\n\n${transcript}`,
        },
      ],
    });

    let text = response.content[0].type === 'text' ? response.content[0].text : '';
    text = stripCodeFences(text);

    // Try to extract JSON object from the response
    const jsonMatch = text.match(/\{[\s\S]*"summary"\s*:[\s\S]*\}/);
    const jsonCandidate = jsonMatch ? jsonMatch[0] : text;

    try {
      const parsed = JSON.parse(jsonCandidate) as ParsedIntelligence;
      return {
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
        actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
        codeReferences: Array.isArray(parsed.codeReferences) ? parsed.codeReferences : [],
        openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        participants: Array.isArray(parsed.participants) ? parsed.participants : [],
      };
    } catch {
      // Return empty result on parse failure rather than crashing
      return {
        ...emptyResult(),
        summary: 'Failed to parse transcript. Raw AI output preserved.',
      };
    }
  },
};
