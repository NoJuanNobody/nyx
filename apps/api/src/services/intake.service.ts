import type Anthropic from '@anthropic-ai/sdk';
import { createPlatformLlmClient, DEFAULT_MODEL } from '../lib/llm.js';

const MODEL = DEFAULT_MODEL;

const client = createPlatformLlmClient();

function requireClient(): Anthropic {
  if (!client) {
    throw new Error('ANTHROPIC_API_KEY is not configured. AI features require a valid API key.');
  }
  return client;
}

export interface StructuredSpec {
  title: string;
  userStory: string;
  acceptanceCriteria: string[];
  edgeCases: string[];
  openQuestions: string[];
  confidence: 'high' | 'medium' | 'low';
  markdown: string;
}

const SYSTEM_PROMPT = `You are a product specification generator. Given raw, unstructured input from a founder or product manager, generate a structured specification.

Your output MUST be valid JSON with this exact format:
{
  "title": "<concise feature title>",
  "userStory": "As a [persona], I want to [action] so that [outcome]",
  "acceptanceCriteria": ["1. ...", "2. ...", ...],
  "edgeCases": ["What happens if...", ...],
  "openQuestions": ["Question that needs founder input before build..."],
  "confidence": "high|medium|low"
}

Rules:
- If the input is too vague to generate acceptance criteria, set confidence to "low" and add specific clarifying questions to openQuestions
- Never hallucinate requirements — if something is ambiguous, ask about it
- Edge cases should be practical, not theoretical
- Acceptance criteria must be testable and unambiguous`;

function buildMarkdown(spec: Omit<StructuredSpec, 'markdown'>): string {
  let md = `# ${spec.title}\n\n`;
  md += `## User Story\n\n${spec.userStory}\n\n`;
  md += `## Acceptance Criteria\n\n`;
  for (const criterion of spec.acceptanceCriteria) {
    md += `- ${criterion}\n`;
  }
  md += `\n## Edge Cases\n\n`;
  for (const edge of spec.edgeCases) {
    md += `- ${edge}\n`;
  }
  if (spec.openQuestions.length > 0) {
    md += `\n## Open Questions\n\n`;
    for (const q of spec.openQuestions) {
      md += `- ${q}\n`;
    }
  }
  md += `\n---\n\n*Confidence: ${spec.confidence}*\n`;
  return md;
}

function parseAIResponse(text: string): StructuredSpec {
  // Strip code fences
  let cleaned = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

  // Try to extract JSON object
  const jsonMatch = cleaned.match(/\{[\s\S]*"title"\s*:[\s\S]*\}/);
  const jsonCandidate = jsonMatch ? jsonMatch[0] : cleaned;

  try {
    const parsed = JSON.parse(jsonCandidate) as Omit<StructuredSpec, 'markdown'>;
    const spec: StructuredSpec = {
      title: parsed.title || 'Untitled Spec',
      userStory: parsed.userStory || '',
      acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria)
        ? parsed.acceptanceCriteria
        : [],
      edgeCases: Array.isArray(parsed.edgeCases) ? parsed.edgeCases : [],
      openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence)
        ? parsed.confidence
        : 'low',
      markdown: '',
    };
    spec.markdown = buildMarkdown(spec);
    return spec;
  } catch {
    // Fallback if parsing fails
    const fallback: StructuredSpec = {
      title: 'Untitled Spec',
      userStory: '',
      acceptanceCriteria: [],
      edgeCases: [],
      openQuestions: ['AI response could not be parsed. Please try again with clearer input.'],
      confidence: 'low',
      markdown: '',
    };
    fallback.markdown = buildMarkdown(fallback);
    return fallback;
  }
}

export const intakeService = {
  async processRawInput(
    rawInput: string,
    _teamId: string,
    _userId: string,
  ): Promise<StructuredSpec> {
    const ai = requireClient();

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Transform the following raw input into a structured product specification:\n\n${rawInput}`,
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return parseAIResponse(text);
  },

  async processWithClarifications(
    rawInput: string,
    questions: string[],
    answers: string[],
    _teamId: string,
    _userId: string,
  ): Promise<StructuredSpec> {
    const ai = requireClient();

    const qaPairs = questions
      .map((q, i) => `Q: ${q}\nA: ${answers[i] || '(no answer provided)'}`)
      .join('\n\n');

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Transform the following raw input into a structured product specification. The founder has answered some clarifying questions — use these answers to produce a more complete spec.\n\n## Original Input\n${rawInput}\n\n## Clarifications\n${qaPairs}`,
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return parseAIResponse(text);
  },
};
