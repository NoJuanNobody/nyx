import Anthropic from '@anthropic-ai/sdk';
import { config } from '../lib/config.js';

const MODEL = 'claude-sonnet-4-20250514';

const client = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  : null;

function requireClient(): Anthropic {
  if (!client) {
    throw new Error('ANTHROPIC_API_KEY is not configured. AI features require a valid API key.');
  }
  return client;
}

// Stage-aware quality criteria
const STAGE_QUALITY_PROMPTS: Record<string, string> = {
  conception:
    'Focus on: clarity of problem definition, evidence of market validation, target user identification, uniqueness of proposed approach, and completeness of problem framing.',
  definition:
    'Focus on: completeness of requirements, unambiguous language, user story coverage with acceptance criteria, measurable success metrics, and clearly bounded scope.',
  architecture:
    'Focus on: technical feasibility, traceability back to PRD requirements, scalability and security considerations, documented trade-offs, and dependency analysis.',
  implementation:
    'Focus on: AI-readiness (can an AI coding agent act on this spec?), testable acceptance criteria, edge case coverage, ticket granularity, and rollback planning.',
  execution:
    'Focus on: documentation freshness, drift coverage against current codebase, release completeness, accuracy of documented behavior, and changelog coverage.',
};

// Seeding prompts by transition
const SEED_PROMPTS: Record<string, string> = {
  'conception->definition':
    'Based on this conception document (problem statement, vision, market analysis), generate a Product Requirements Document. Extract clear requirements, user stories with acceptance criteria, success metrics, and scope boundaries. Structure it as a proper PRD.',
  'definition->architecture':
    'Based on this product requirements document, design the system architecture. Include data model design, API contracts, component specifications, and key architectural decisions. Trace each architecture element back to a requirement.',
  'architecture->implementation':
    'Based on this architecture document, create an implementation specification. Include step-by-step coding plan, file-by-file changes, acceptance criteria, test plan, edge cases, and a ticket breakdown. Make it actionable for an AI coding agent.',
  'implementation->execution':
    'Based on this implementation specification, generate execution documentation. Include release notes template, deployment checklist, drift monitoring setup, and changelog entries. Focus on what was built and how to verify it.',
};

export const aiService = {
  async analyzeSpecQuality(
    content: string,
    stage?: string | null,
  ): Promise<{ score: number; suggestions: string[] }> {
    const ai = requireClient();

    const stageContext = stage && STAGE_QUALITY_PROMPTS[stage]
      ? `\n\nThis is a "${stage}" stage document. ${STAGE_QUALITY_PROMPTS[stage]}`
      : '';

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        `You are a technical specification quality analyzer. Given a spec document, rate its quality from 1 to 10 and provide actionable improvement suggestions. Respond ONLY with valid JSON in this exact format: {"score": <number>, "suggestions": ["suggestion1", "suggestion2", ...]}${stageContext}`,
      messages: [
        {
          role: 'user',
          content: `Analyze the quality of this specification document:\n\n${content}`,
        },
      ],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    try {
      const parsed = JSON.parse(text) as { score: number; suggestions: string[] };
      return {
        score: parsed.score,
        suggestions: parsed.suggestions,
      };
    } catch {
      return { score: 5, suggestions: [text] };
    }
  },

  async detectDrift(
    specContent: string,
    codeContent: string,
  ): Promise<{
    hasDrift: boolean;
    driftScore: number;
    details: string;
    suggestions: string[];
  }> {
    const ai = requireClient();

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        'You are a code-spec drift detector. Compare the specification with the code and identify any mismatches. Respond ONLY with valid JSON in this exact format: {"hasDrift": <boolean>, "driftScore": <number 0-10>, "details": "<description>", "suggestions": ["fix1", "fix2", ...]}',
      messages: [
        {
          role: 'user',
          content: `Compare this specification with the code and identify drift:\n\n## Specification\n${specContent}\n\n## Code\n${codeContent}`,
        },
      ],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    try {
      const parsed = JSON.parse(text) as {
        hasDrift: boolean;
        driftScore: number;
        details: string;
        suggestions: string[];
      };
      return parsed;
    } catch {
      return {
        hasDrift: false,
        driftScore: 0,
        details: text,
        suggestions: [],
      };
    }
  },

  async generateTicketFromDiff(
    specDiff: string,
    context?: string,
  ): Promise<{ title: string; description: string; labels: string[] }> {
    const ai = requireClient();

    const contextBlock = context ? `\n\nAdditional context: ${context}` : '';

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        'You are a ticket generator. Given a diff between specification versions, generate a well-formatted ticket. Respond ONLY with valid JSON in this exact format: {"title": "<short title>", "description": "<detailed markdown description>", "labels": ["label1", "label2", ...]}',
      messages: [
        {
          role: 'user',
          content: `Generate a ticket from this specification diff:\n\n${specDiff}${contextBlock}`,
        },
      ],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    try {
      const parsed = JSON.parse(text) as {
        title: string;
        description: string;
        labels: string[];
      };
      return parsed;
    } catch {
      return {
        title: 'Update implementation to match spec changes',
        description: text,
        labels: ['spec-change'],
      };
    }
  },

  async generateDocument(
    prompt: string,
  ): Promise<{ title: string; content: string }> {
    const ai = requireClient();

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        'You are a technical documentation writer. Given a prompt, generate a well-structured document with a clear title and markdown content. Respond ONLY with valid JSON in this exact format: {"title": "<document title>", "content": "<full markdown content>"}',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    try {
      const parsed = JSON.parse(text) as { title: string; content: string };
      return {
        title: parsed.title || 'Untitled Document',
        content: parsed.content || text,
      };
    } catch {
      return { title: 'Untitled Document', content: text };
    }
  },

  async editDocument(
    currentContent: string,
    instruction: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<string> {
    const ai = requireClient();

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    // Include conversation history (last 10 turns) for iterative context
    if (history && history.length > 0) {
      const recentHistory = history.slice(-10);
      messages.push(...recentHistory);
    }

    messages.push({
      role: 'user',
      content: `Here is the current document:\n\n${currentContent}\n\n---\n\nInstruction: ${instruction}`,
    });

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        'You are an expert document editor. Given a document and an editing instruction, return ONLY the updated markdown content. Do not wrap the output in code fences. Do not include any explanations — just the raw updated markdown.',
      messages,
    });

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip leading/trailing triple backticks if AI wraps output
    text = text.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '');

    return text;
  },

  async analyzeChangesForTickets(
    changes: Array<{ version: number; message: string | null; content: string }>,
    documentTitle: string,
  ): Promise<{ title: string; description: string; suggestedTickets: Array<{ title: string; description: string; priority: string; labels: string[] }> }> {
    const ai = requireClient();

    const changeSummary = changes
      .map((c) => `### Version ${c.version}${c.message ? ` — ${c.message}` : ''}\n${c.content.slice(0, 1000)}`)
      .join('\n\n');

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system:
        'You are a change analyst for a documentation platform. Given a set of document version changes, analyze them and suggest ticket groupings. Group related changes into logical tickets. Respond ONLY with valid JSON in this exact format: {"title": "<proposal title>", "description": "<summary of all changes>", "suggestedTickets": [{"title": "<ticket title>", "description": "<detailed description>", "priority": "high|medium|low", "labels": ["label1"]}]}',
      messages: [
        {
          role: 'user',
          content: `Analyze these changes to the document "${documentTitle}" and suggest tickets:\n\n${changeSummary}`,
        },
      ],
    });

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip markdown code fences the model sometimes wraps around JSON
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

    try {
      return JSON.parse(text) as { title: string; description: string; suggestedTickets: Array<{ title: string; description: string; priority: string; labels: string[] }> };
    } catch {
      return {
        title: `Changes to ${documentTitle}`,
        description: text,
        suggestedTickets: [{ title: `Update ${documentTitle}`, description: text, priority: 'medium', labels: ['spec-change'] }],
      };
    }
  },

  async generateJSXPreview(
    prompt: string,
    context?: string,
  ): Promise<string> {
    const ai = requireClient();

    const contextBlock = context ? `\n\nAdditional context from the spec:\n${context}` : '';

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        `You are an expert React component generator. Given a description, generate a single self-contained React component that can be rendered in a browser.

STRICT RULES:
1. Output ONLY the raw JSX/JavaScript code — no markdown, no code fences, no explanations
2. The component MUST be a plain function named "App": function App() { ... } — do NOT use export default
3. Use ONLY inline Tailwind CSS classes for styling (Tailwind is available via CDN)
4. Do NOT use any imports — React, ReactDOM, and Tailwind are available as globals
5. Do NOT use TypeScript — plain JavaScript/JSX only
6. The component must be entirely self-contained with its own sample data
7. For charts, use inline SVG elements (no external chart libraries)
8. Keep the component realistic and visually polished`,
      messages: [
        {
          role: 'user',
          content: `Generate a React component for: ${prompt}${contextBlock}`,
        },
      ],
    });

    let text = response.content[0].type === 'text' ? response.content[0].text : '';
    // Strip code fences if model wraps output
    text = text.replace(/^```(?:jsx?|javascript|tsx?)?\n?/, '').replace(/\n?```$/, '').trim();
    return text;
  },

  async refineJSXPreview(
    currentJSX: string,
    refinementPrompt: string,
  ): Promise<string> {
    const ai = requireClient();

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        `You are an expert React component editor. Given an existing React component and a refinement instruction, return the updated component.

STRICT RULES:
1. Output ONLY the raw JSX/JavaScript code — no markdown, no code fences, no explanations
2. Preserve the default export named "App": export default function App() { ... }
3. Use ONLY inline Tailwind CSS classes for styling
4. Do NOT use any imports — React, ReactDOM, and Tailwind are available as globals
5. Do NOT use TypeScript — plain JavaScript/JSX only
6. Apply ONLY the requested changes; preserve all other aspects of the component`,
      messages: [
        {
          role: 'user',
          content: `Here is the current component:\n\n${currentJSX}\n\n---\n\nRefinement instruction: ${refinementPrompt}`,
        },
      ],
    });

    let text = response.content[0].type === 'text' ? response.content[0].text : '';
    text = text.replace(/^```(?:jsx?|javascript|tsx?)?\n?/, '').replace(/\n?```$/, '').trim();
    return text;
  },

  async bootstrapDocsFromCode(
    files: Array<{ path: string; content: string }>,
  ): Promise<string> {
    const ai = requireClient();

    const filesSummary = files
      .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
      .join('\n\n');

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        'You are a technical documentation generator. Given a set of code files from a repository, generate comprehensive initial documentation in Markdown format. Include: project overview, architecture notes, key modules, setup instructions if inferable, and any important patterns you notice.',
      messages: [
        {
          role: 'user',
          content: `Generate documentation from these code files:\n\n${filesSummary}`,
        },
      ],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    return text;
  },

  async seedNextStage(
    content: string,
    fromStage: string,
    toStage: string,
  ): Promise<{ title: string; content: string }> {
    const ai = requireClient();

    const transitionKey = `${fromStage}->${toStage}`;
    const seedPrompt = SEED_PROMPTS[transitionKey] ||
      `Based on this ${fromStage} document, generate appropriate content for a ${toStage} stage document.`;

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        `You are a technical documentation expert helping teams progress through their product lifecycle. ${seedPrompt} Respond ONLY with valid JSON in this exact format: {"title": "<document title>", "content": "<full markdown content>"}`,
      messages: [
        {
          role: 'user',
          content: `Generate the next-stage document from this source:\n\n${content}`,
        },
      ],
    });

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip code fences (```json ... ``` or ``` ... ```) anywhere in the text
    text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

    // Try to extract a JSON object from the text (AI may wrap it in extra prose)
    const jsonMatch = text.match(/\{[\s\S]*"content"\s*:\s*"[\s\S]*\}/);
    const jsonCandidate = jsonMatch ? jsonMatch[0] : text;

    try {
      const parsed = JSON.parse(jsonCandidate) as { title: string; content: string };
      return {
        title: parsed.title || 'Untitled Document',
        content: parsed.content || text,
      };
    } catch {
      // Fallback: extract title from first markdown heading
      const headingMatch = text.match(/^#\s+(.+)$/m);
      return {
        title: headingMatch ? headingMatch[1].trim() : 'Untitled Document',
        content: text,
      };
    }
  },
};
