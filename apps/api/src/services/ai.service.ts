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

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip code fences
    text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

    // Try to extract JSON object from response
    const jsonMatch = text.match(/\{[\s\S]*"score"\s*:[\s\S]*"suggestions"\s*:[\s\S]*\}/);
    const jsonCandidate = jsonMatch ? jsonMatch[0] : text;

    try {
      const parsed = JSON.parse(jsonCandidate) as { score: number; suggestions: string[] };
      return {
        score: typeof parsed.score === 'number' ? parsed.score : 5,
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    } catch {
      // Extract score from text if possible, treat rest as suggestion
      const scoreMatch = text.match(/(\d+)\s*\/\s*10/);
      return {
        score: scoreMatch ? parseInt(scoreMatch[1], 10) : 5,
        suggestions: [text],
      };
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
    allStates?: boolean,
  ): Promise<string> {
    const ai = requireClient();

    const contextBlock = context ? `\n\nAdditional context from the spec:\n${context}` : '';

    const statesBlock = allStates
      ? '\n\nIMPORTANT: Render ALL meaningful component states in a single vertically-scrollable layout. Use labeled sections with a small heading/badge for each state: Loading, Empty, Error, Populated (default), and Disabled/Read-only where applicable. Each section should be visually distinct but share the same component design.'
      : '';

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
          content: `Generate a React component for: ${prompt}${contextBlock}${statesBlock}`,
        },
      ],
    });

    let text = response.content[0].type === 'text' ? response.content[0].text : '';
    // Strip code fences if model wraps output (global match for robustness)
    text = text.replace(/```(?:jsx?|javascript|tsx?)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();
    // Strip any import statements the model may have included
    text = text.replace(/^\s*import\s+.*?(?:from\s+['"].*?['"]|['"].*?['"])\s*;?\s*$/gm, '');
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
2. The component MUST be a plain function named "App": function App() { ... } — do NOT use export default
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

  async analyzeMissingSections(
    content: string,
    stage?: string | null,
  ): Promise<{
    missingSections: Array<{ name: string; description: string; priority: 'high' | 'medium' | 'low' }>;
  }> {
    const ai = requireClient();

    const stageContext = stage && STAGE_QUALITY_PROMPTS[stage]
      ? `\n\nThis is a "${stage}" stage document. ${STAGE_QUALITY_PROMPTS[stage]}`
      : '';

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        `You are a technical specification completeness analyzer. Given a document, identify any important sections that are missing. Respond ONLY with valid JSON in this exact format: {"missingSections": [{"name": "<section name>", "description": "<why this section matters>", "priority": "high" | "medium" | "low"}]}${stageContext}`,
      messages: [
        {
          role: 'user',
          content: `Analyze this document for missing sections:\n\n${content}`,
        },
      ],
    });

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip code fences
    text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

    try {
      const parsed = JSON.parse(text) as {
        missingSections: Array<{ name: string; description: string; priority: 'high' | 'medium' | 'low' }>;
      };
      return {
        missingSections: Array.isArray(parsed.missingSections) ? parsed.missingSections : [],
      };
    } catch {
      return { missingSections: [] };
    }
  },

  async notificationReply(
    notificationId: string,
    message: string,
    documentContent: string,
  ): Promise<{ reply: string; suggestedActions: string[] }> {
    const ai = requireClient();

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        'You are an AI advisor assistant for a documentation platform. A user is replying to a notification about their document. Provide a helpful follow-up response. Respond ONLY with valid JSON in this exact format: {"reply": "<your response>", "suggestedActions": ["action1", "action2"]}',
      messages: [
        {
          role: 'user',
          content: `Notification ID: ${notificationId}\n\nUser message: ${message}\n\nDocument context:\n${documentContent.slice(0, 2000)}`,
        },
      ],
    });

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip code fences
    text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

    try {
      const parsed = JSON.parse(text) as { reply: string; suggestedActions: string[] };
      return {
        reply: parsed.reply || text,
        suggestedActions: Array.isArray(parsed.suggestedActions) ? parsed.suggestedActions : [],
      };
    } catch {
      return { reply: text, suggestedActions: [] };
    }
  },

  async generateBulkTicketSuggestions(
    content: string,
    title: string,
    stage: string | null,
    codeContext?: string,
  ): Promise<Array<{ title: string; description: string; labels: string[] }>> {
    const ai = requireClient();

    const truncatedContent = content.slice(0, 8000);
    const truncatedCode = codeContext ? codeContext.slice(0, 4000) : '';

    let stageFocus = '';
    if (stage && ['conception', 'definition'].includes(stage)) {
      stageFocus = 'Focus on requirement gaps, missing user stories, and unanswered questions.';
    } else if (stage && ['architecture', 'implementation'].includes(stage)) {
      stageFocus = 'Focus on code changes, API contracts, migration tasks, and test coverage.';
    } else if (stage === 'execution') {
      stageFocus = 'Focus on drift remediation and documentation updates.';
    }

    const stageContext = stage && STAGE_QUALITY_PROMPTS[stage]
      ? `\n\nThis is a "${stage}" stage document. ${STAGE_QUALITY_PROMPTS[stage]}`
      : '';

    const codeBlock = truncatedCode
      ? `\n\nLinked code context:\n${truncatedCode}`
      : '';

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        `You are a ticket suggestion engine for a documentation platform. Given a document and optional code context, generate 5-10 actionable ticket suggestions. ${stageFocus}${stageContext}

Each ticket must have:
- title: prefixed with [S], [M], or [L] for estimated scope (small/medium/large)
- description: must include a "## Context" section citing the specific spec heading or section, an "## Affected Areas" section listing file paths or modules, and an "## Acceptance Criteria" section with a markdown checklist of verifiable conditions
- labels: array of relevant labels (e.g., bug, enhancement, drift, spec-gap)

Respond ONLY with a valid JSON array of objects with title, description, and labels fields.`,
      messages: [
        {
          role: 'user',
          content: `Generate ticket suggestions for the document "${title}":\n\n${truncatedContent}${codeBlock}`,
        },
      ],
    });

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip code fences
    text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

    try {
      const parsed = JSON.parse(text) as Array<{ title: string; description: string; labels: string[] }>;
      if (Array.isArray(parsed)) {
        return parsed;
      }
      return [{ title: `[M] Review "${title}"`, description: text, labels: ['spec-review'] }];
    } catch {
      return [{ title: `[M] Review "${title}"`, description: text, labels: ['spec-review'] }];
    }
  },

  /**
   * Estimate the decision weight of a document — a capacity metric that measures
   * the human judgment cost to ship what the doc describes.
   * Returns a composite score (1–100) with a breakdown of contributing signals.
   */
  async estimateDecisionWeight(
    content: string,
    stage?: string | null,
  ): Promise<{
    weight: number;
    breakdown: {
      ambiguity: number;
      integrationSurface: number;
      validationDifficulty: number;
      scopeSpread: number;
      novelty: number;
    };
    bottlenecks: string[];
    reviewCycles: number;
  }> {
    const ai = requireClient();

    const stageContext = stage
      ? `\n\nThis is a "${stage}" stage document. Earlier stages (conception, definition) typically carry higher ambiguity; later stages (implementation, execution) carry higher validation difficulty.`
      : '';

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        `You are a capacity estimation engine for AI-agent-heavy development teams. The bottleneck is no longer writing code — it is human judgment: reviewing, deciding, and integrating.

Given a specification document, estimate its DECISION WEIGHT — the human judgment cost to ship what this doc describes. Analyze these five signals:

1. **ambiguity** (1–20): Count of TBDs, open questions, vague language, undefined terms, missing acceptance criteria. Higher = more decisions the team must resolve.
2. **integrationSurface** (1–20): Number of external systems, APIs, other components, or teams this work touches. Each seam requires human coordination.
3. **validationDifficulty** (1–20): How hard is it to verify correctness? Visual UI is easy (low). Sync logic, data integrity, state management, security — these need deep review (high).
4. **scopeSpread** (1–20): How many distinct work items does this doc imply? More items = more review cycles and integration points.
5. **novelty** (1–20): Is there prior art to compare against, or is this greenfield? Novel work requires more judgment per unit of output.

Also estimate **reviewCycles** — the number of human review passes this work will realistically require before it's shippable (1–10).

Identify the top 2–4 **bottlenecks** — specific items in the doc driving the weight up (e.g., "No acceptance criteria for the sync endpoint", "Touches 4 external APIs with no error contract defined").

Respond ONLY with valid JSON:
{"weight": <sum of 5 signals, 5–100>, "breakdown": {"ambiguity": <n>, "integrationSurface": <n>, "validationDifficulty": <n>, "scopeSpread": <n>, "novelty": <n>}, "bottlenecks": ["...", "..."], "reviewCycles": <n>}${stageContext}`,
      messages: [
        {
          role: 'user',
          content: `Estimate the decision weight of this specification:\n\n${content.slice(0, 8000)}`,
        },
      ],
    });

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip code fences
    text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

    try {
      const parsed = JSON.parse(text) as {
        weight: number;
        breakdown: {
          ambiguity: number;
          integrationSurface: number;
          validationDifficulty: number;
          scopeSpread: number;
          novelty: number;
        };
        bottlenecks: string[];
        reviewCycles: number;
      };
      // Ensure weight equals sum of breakdown
      const b = parsed.breakdown;
      const sum = b.ambiguity + b.integrationSurface + b.validationDifficulty + b.scopeSpread + b.novelty;
      return {
        weight: sum,
        breakdown: b,
        bottlenecks: Array.isArray(parsed.bottlenecks) ? parsed.bottlenecks : [],
        reviewCycles: typeof parsed.reviewCycles === 'number' ? parsed.reviewCycles : 3,
      };
    } catch {
      return {
        weight: 50,
        breakdown: { ambiguity: 10, integrationSurface: 10, validationDifficulty: 10, scopeSpread: 10, novelty: 10 },
        bottlenecks: ['Could not parse document for capacity estimation'],
        reviewCycles: 3,
      };
    }
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
