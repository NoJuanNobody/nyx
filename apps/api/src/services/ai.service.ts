import * as Sentry from '@sentry/node';
import Anthropic from '@anthropic-ai/sdk';
import { eq, and } from 'drizzle-orm';
import { config } from '../lib/config.js';
import { decrypt } from './encryption.service.js';

const MODEL = 'claude-sonnet-4-20250514';
const MODEL_FAST = 'claude-haiku-4-5-20251001';

/** Parse a JSON array from AI text, handling code fences, prose wrapping, and truncation. */
function parseJsonArray(raw: string): Array<{ title: string; description: string; labels: string[] }> {
  let text = raw.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    text = text.slice(firstBracket, lastBracket + 1);
  }

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Try salvaging truncated JSON
    try {
      const lastComplete = text.lastIndexOf('},');
      if (lastComplete > 0) {
        const salvaged = JSON.parse(text.slice(0, lastComplete + 1) + ']');
        if (Array.isArray(salvaged) && salvaged.length > 0) return salvaged;
      }
    } catch { /* fall through */ }
  }
  return [];
}

const client = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  : null;

// ── BYOK client cache ────────────────────────────────────────────────
const teamClientCache = new Map<string, { client: Anthropic; expiresAt: number }>();
const CLIENT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Invalidate the cached AI client for a team (e.g., on key rotation or removal).
 */
export function invalidateTeamClient(teamId: string): void {
  teamClientCache.delete(teamId);
}

/**
 * Get or create a cached Anthropic client for a team's BYOK key.
 */
function getOrCreateCachedClient(teamId: string, apiKey: string): Anthropic {
  const cached = teamClientCache.get(teamId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.client;
  }
  const teamClient = new Anthropic({ apiKey });
  teamClientCache.set(teamId, { client: teamClient, expiresAt: Date.now() + CLIENT_TTL_MS });
  return teamClient;
}

/**
 * Resolve the Anthropic client — uses team BYOK key if available, else falls back
 * to the platform-managed key.
 */
async function resolveClient(teamId?: string): Promise<Anthropic> {
  if (teamId) {
    try {
      // Dynamic import to avoid circular deps at module load
      const { db } = await import('../db/index.js');
      const { teamAiKeys } = await import('../db/schema.js');

      const [teamKey] = await db
        .select({
          encryptedKey: teamAiKeys.encryptedKey,
          keyIv: teamAiKeys.keyIv,
        })
        .from(teamAiKeys)
        .where(
          and(
            eq(teamAiKeys.teamId, teamId),
            eq(teamAiKeys.provider, 'anthropic'),
            eq(teamAiKeys.isActive, true),
          ),
        )
        .limit(1);

      if (teamKey && config.BYOK_ENCRYPTION_SECRET) {
        const decryptedKey = decrypt(
          { ciphertext: teamKey.encryptedKey, iv: teamKey.keyIv },
          config.BYOK_ENCRYPTION_SECRET,
        );
        return getOrCreateCachedClient(teamId, decryptedKey);
      }
    } catch (err) {
      Sentry.captureException(err);
      // Fall through to platform key on any error
    }
  }

  if (!client) {
    throw new Error('No AI key available. Configure ANTHROPIC_API_KEY or add a team key.');
  }
  return client;
}

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
    'Based on this conception document (problem statement, vision, market analysis), generate a Product Requirements Document in **markdown format**. Extract clear requirements, user stories with acceptance criteria, success metrics, and scope boundaries. Structure it as a proper PRD.',
  'definition->architecture':
    'Based on this product requirements document, design the system architecture in **markdown format**. Include data model design, API contracts, component specifications, and key architectural decisions. Trace each architecture element back to a requirement.',
  'architecture->implementation':
    'Based on this architecture document, create an implementation specification in **markdown format**. Include step-by-step coding plan, file-by-file changes, acceptance criteria, test plan, edge cases, and a ticket breakdown. Make it actionable for an AI coding agent.',
  'implementation->execution':
    'Based on this implementation specification, generate execution documentation in **markdown format**. Include release notes template, deployment checklist, drift monitoring setup, and changelog entries. Focus on what was built and how to verify it.',
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
        `You are a technical specification quality analyzer. Given a spec document, rate its quality from 1 to 10 and provide actionable improvement suggestions. A score of 10/10 is explicitly achievable and should be awarded when warranted.

Scoring guide:
- 1-3: Major gaps — missing sections, vague language, no actionable detail
- 4-6: Partial — covers basics but has significant omissions or ambiguity
- 7-8: Solid — well-structured, mostly complete, minor improvements possible
- 9: Excellent — comprehensive, clear, actionable, with only trivial polish remaining
- 10: Exceptional — comprehensive coverage, unambiguous language, fully actionable with clear acceptance criteria, addresses edge cases, and requires no further clarification to implement

If the document meets all criteria for its stage and requires no meaningful improvements, score it 10. Do not withhold a perfect score simply because "there is always room for improvement."

Respond ONLY with valid JSON in this exact format: {"score": <number>, "suggestions": ["suggestion1", "suggestion2", ...]}${stageContext}`,
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
        `You are a ticket generator for a software engineering team. Given a diff between specification versions, generate a well-formatted ticket that describes **concrete code implementation work** — NOT documentation tasks.

CRITICAL RULES:
- Tickets must describe code changes: new features, bug fixes, refactors, API changes, database migrations, test additions, or infrastructure work.
- NEVER generate tickets whose primary goal is to "create documentation", "update docs", "write a guide", or "add README". Documentation-only tickets are acceptable ONLY when the spec explicitly identifies a missing doc as the sole gap.
- Titles must be action-oriented toward code: "Implement ...", "Add ...", "Fix ...", "Refactor ...", "Migrate ...", etc.

GOOD ticket titles:
- "Implement rate limiting on /api/projects endpoint"
- "Add input validation for team invitation flow"
- "Fix race condition in document version save"
- "Refactor auth middleware to support BYOK keys"

BAD ticket titles (do NOT generate these):
- "Create documentation for the API"
- "Update README with setup instructions"
- "Document the new authentication flow"
- "Write user guide for dashboard features"

Respond ONLY with valid JSON in this exact format: {"title": "<short title>", "description": "<detailed markdown description>", "labels": ["label1", "label2", ...]}`,
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
        title: 'Implement code changes to match spec updates',
        description: text,
        labels: ['spec-change', 'implementation'],
      };
    }
  },

  async generateDocument(
    prompt: string,
  ): Promise<{ title: string; content: string }> {
    const ai = requireClient();

    const response = await ai.messages.create({
      model: MODEL_FAST,
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
      model: MODEL_FAST,
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
        `You are a change analyst for a software engineering team. Given a set of document version changes, analyze them and suggest ticket groupings. Group related changes into logical tickets that describe **concrete code implementation work**.

CRITICAL RULES:
- Each suggested ticket must describe actionable engineering work: new features, bug fixes, refactors, API changes, database migrations, test additions, or infrastructure tasks.
- NEVER suggest tickets whose primary goal is to "create documentation", "update docs", or "write a guide". Documentation-only tickets are acceptable ONLY when the change explicitly identifies a missing doc as the sole gap.
- Ticket titles must be action-oriented toward code changes: "Implement ...", "Add ...", "Fix ...", "Refactor ...", "Migrate ...", etc.

Respond ONLY with valid JSON in this exact format: {"title": "<proposal title>", "description": "<summary of all changes>", "suggestedTickets": [{"title": "<ticket title>", "description": "<detailed description>", "priority": "high|medium|low", "labels": ["label1"]}]}`,
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

  async bootstrapModuleDocs(
    moduleName: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<string> {
    const ai = requireClient();

    const filesSummary = files
      .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
      .join('\n\n');

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: `You are a technical documentation generator focused on the "${moduleName}" module of a codebase. Analyze the provided source files and generate focused documentation in Markdown format. Include:
- **Purpose**: What this module does and its responsibilities
- **Key workflows**: Step-by-step data flows
- **API surface**: Exported functions, endpoints, type signatures
- **Dependencies**: What it imports, what depends on it
- **Configuration**: Relevant env vars, feature flags

Be concise but thorough. Use code references where helpful.`,
      messages: [
        {
          role: 'user',
          content: `Generate documentation for the "${moduleName}" module from these files:\n\n${filesSummary}`,
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    return text;
  },

  async mergeModuleDocs(
    moduleDocs: Array<{ module: string; docs: string }>,
    repoName: string,
  ): Promise<string> {
    const ai = requireClient();

    const sections = moduleDocs
      .map((m) => `## Module: ${m.module}\n\n${m.docs}`)
      .join('\n\n---\n\n');

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: `You are a technical documentation editor. You are given per-module documentation for the "${repoName}" repository. Merge them into a single, well-structured document with:
1. A project overview section (synthesized from all modules)
2. Architecture overview (how modules connect)
3. Each module as a section with its documentation
4. End-to-end workflows that cross modules

Preserve the technical detail from each module doc. Use clean Markdown formatting with headers, lists, and code blocks.`,
      messages: [
        {
          role: 'user',
          content: `Merge these module docs into a structured document for ${repoName}:\n\n${sections}`,
        },
      ],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
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

  /** Parse a JSON array from AI text output, handling code fences and truncation. */
  _parseJsonArray(text: string): Array<{ title: string; description: string; labels: string[] }> {
    return parseJsonArray(text);
  },

  async generateBulkTicketSuggestions(
    content: string,
    title: string,
    stage: string | null,
    codeContext?: string,
  ): Promise<Array<{ title: string; description: string; labels: string[] }>> {
    const ai = requireClient();

    const truncatedContent = content.slice(0, 12000);
    const truncatedCode = codeContext ? codeContext.slice(0, 3000) : '';

    let stageFocus = '';
    if (stage && ['conception', 'definition'].includes(stage)) {
      stageFocus = 'Focus on requirement gaps, missing user stories, and unanswered questions that need code solutions.';
    } else if (stage && ['architecture', 'implementation'].includes(stage)) {
      stageFocus = 'Focus on code changes, API contracts, migration tasks, and test coverage.';
    } else if (stage === 'execution') {
      stageFocus = 'Focus on drift remediation — code fixes to bring implementation back in sync with specs.';
    }

    const stageContext = stage && STAGE_QUALITY_PROMPTS[stage]
      ? `\n\nThis is a "${stage}" stage document. ${STAGE_QUALITY_PROMPTS[stage]}`
      : '';

    const codeBlock = truncatedCode
      ? `\n\nLinked code context:\n${truncatedCode}`
      : '';

    // ── Phase 1: Fast outline — titles + labels only (~5-10s) ──
    const outlineResponse = await ai.messages.create({
      model: MODEL_FAST,
      max_tokens: 4096,
      system: `Ticket planning engine. List exactly the tickets needed to implement the document. Each ticket = one independently deliverable unit of code work. ${stageFocus}${stageContext}

Rules:
- Code work only: features, bugs, tests, APIs, migrations, security. No doc-only tickets.
- Title: "[S]"/"[M]"/"[L]" prefix + action verb
- Labels: 1-3 labels
- Description: one sentence summary ONLY (details will be expanded separately)

JSON array only: [{title, description, labels}]`,
      messages: [
        { role: 'user', content: `Plan tickets for "${title}":\n\n${truncatedContent}${codeBlock}` },
      ],
    });

    const outlineTickets = parseJsonArray(
      outlineResponse.content[0].type === 'text' ? outlineResponse.content[0].text : '',
    );

    if (outlineTickets.length === 0) {
      return [{ title: `[M] Review "${title}"`, description: 'AI generated suggestions but they could not be parsed. Please try again.', labels: ['spec-review'] }];
    }

    // ── Phase 2: Expand every ticket individually in parallel ──
    // Each call sees the full ticket list to avoid overlap.
    const docContext = truncatedContent.slice(0, 4000);
    const allTitles = outlineTickets.map((t, i) => `${i + 1}. ${t.title}`).join('\n');

    const expanded = await Promise.all(
      outlineTickets.map(async (ticket, idx) => {
        try {
          const response = await ai.messages.create({
            model: MODEL_FAST,
            max_tokens: 2048,
            system: `Expand ticket #${idx + 1} into a detailed implementation spec. Return ONLY the markdown description (no JSON, no wrapping). Include these sections:

## Context
Which spec section this addresses and WHY.

## Implementation Details
Step-by-step: what code to write, patterns, libraries/APIs, data flow, error handling. Specific enough to start coding.

## Affected Areas
Specific file paths, modules, DB tables, API endpoints, or components.

## Acceptance Criteria
3-8 testable checklist items. Specific, not vague.

IMPORTANT: Focus ONLY on this ticket's scope. Do NOT overlap with other tickets in the plan. Here is the full ticket list for context — the other tickets handle everything not in your scope:
${allTitles}`,
            messages: [
              { role: 'user', content: `Expand ticket #${idx + 1}:\nTitle: ${ticket.title}\nSummary: ${ticket.description}\n\nFrom document "${title}":\n${docContext}` },
            ],
          });

          const desc = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
          return {
            title: ticket.title,
            description: desc || ticket.description,
            labels: ticket.labels,
          };
        } catch {
          return ticket; // Keep outline on failure
        }
      }),
    );

    return expanded;
  },

  /**
   * Expand a brief ticket suggestion into a full implementation description.
   * Called on-demand when a user clicks into a ticket for details.
   */
  async expandTicketDescription(
    ticketTitle: string,
    briefDescription: string,
    docTitle: string,
    docContent: string,
  ): Promise<string> {
    const ai = requireClient();

    const response = await ai.messages.create({
      model: MODEL_FAST,
      max_tokens: 1024,
      system: 'Expand a brief ticket into a detailed implementation description. Include: ## Context (which part of the spec), ## Affected Areas (files/modules), ## Acceptance Criteria (checklist). Be specific and actionable. Return markdown only, no JSON.',
      messages: [
        {
          role: 'user',
          content: `Ticket: ${ticketTitle}\nBrief: ${briefDescription}\n\nFrom document "${docTitle}":\n${docContent}`,
        },
      ],
    });

    return response.content[0].type === 'text' ? response.content[0].text : briefDescription;
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

  async generatePodcastScript(
    content: string,
    title?: string,
  ): Promise<{
    title: string;
    script: Array<{ speaker: 'Host A' | 'Host B'; text: string }>;
    qualityScore: number;
    suggestions: string[];
  }> {
    const ai = requireClient();

    const titleHint = title ? `\nThe podcast should be titled: "${title}"` : '';

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        `You are a podcast script generator. Given technical documentation content, create an engaging conversational podcast script between two hosts (Host A and Host B). Host A is the main presenter who explains concepts, and Host B asks clarifying questions and adds commentary. Also assess the quality of the source documentation.${titleHint}

Respond ONLY with valid JSON in this exact format:
{"title": "<podcast episode title>", "script": [{"speaker": "Host A", "text": "<dialogue>"}, {"speaker": "Host B", "text": "<dialogue>"}, ...], "qualityScore": <number 1-10>, "suggestions": ["suggestion1", "suggestion2", ...]}`,
      messages: [
        {
          role: 'user',
          content: `Generate a podcast script from this documentation:\n\n${content}`,
        },
      ],
    });

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip code fences
    text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

    try {
      const parsed = JSON.parse(text) as {
        title: string;
        script: Array<{ speaker: 'Host A' | 'Host B'; text: string }>;
        qualityScore: number;
        suggestions: string[];
      };
      return {
        title: parsed.title || title || 'Untitled Podcast',
        script: Array.isArray(parsed.script) ? parsed.script : [],
        qualityScore: typeof parsed.qualityScore === 'number' ? parsed.qualityScore : 5,
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    } catch {
      return {
        title: title || 'Untitled Podcast',
        script: [{ speaker: 'Host A', text: text }],
        qualityScore: 5,
        suggestions: [],
      };
    }
  },

  async generateRadioShowScript(
    segments: Array<{ title: string; content: string }>,
    showName?: string,
  ): Promise<{
    title: string;
    script: Array<{ speaker: 'Host A' | 'Host B'; text: string }>;
    qualityScore: number;
    suggestions: string[];
  }> {
    const ai = requireClient();

    const showTitle = showName || 'The Nyx Radio Show';
    const segmentList = segments
      .map((s, i) => `--- SEGMENT ${i + 1}: ${s.title} ---\n${s.content}`)
      .join('\n\n');

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: `You are a radio show script generator. You create engaging, professional radio show scripts with two co-hosts (Host A and Host B). Host A is the lead presenter and Host B is the color commentator who adds energy, asks questions, and reacts.

The show is called "${showTitle}". Generate a full radio show script that includes:
1. An exciting opening intro where the hosts welcome listeners and preview what's coming up
2. Multiple segments based on the provided topics, each covering one document
3. Smooth transitions between segments where hosts briefly recap and tease the next topic
4. A closing outro where hosts wrap up highlights and sign off

Make it feel like a real radio show — energetic, conversational, with natural banter between hosts. Each segment should feel distinct but the overall show should flow naturally.

Respond ONLY with valid JSON in this exact format:
{"title": "<show episode title>", "script": [{"speaker": "Host A", "text": "<dialogue>"}, {"speaker": "Host B", "text": "<dialogue>"}, ...], "qualityScore": <number 1-10>, "suggestions": ["suggestion1", "suggestion2", ...]}`,
      messages: [
        {
          role: 'user',
          content: `Generate a radio show script covering these ${segments.length} topics:\n\n${segmentList}`,
        },
      ],
    });

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

    try {
      const parsed = JSON.parse(text) as {
        title: string;
        script: Array<{ speaker: 'Host A' | 'Host B'; text: string }>;
        qualityScore: number;
        suggestions: string[];
      };
      return {
        title: parsed.title || showTitle,
        script: Array.isArray(parsed.script) ? parsed.script : [],
        qualityScore: typeof parsed.qualityScore === 'number' ? parsed.qualityScore : 5,
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    } catch {
      return {
        title: showTitle,
        script: [{ speaker: 'Host A', text }],
        qualityScore: 5,
        suggestions: [],
      };
    }
  },

  async analyzeMeetingNoteQuality(
    content: string,
  ): Promise<{
    score: number;
    suggestions: string[];
    meetingMetrics: {
      decisions: number;
      actionItems: number;
      codeReferences: number;
      openQuestions: number;
    };
  }> {
    const ai = requireClient();

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        `You are a meeting notes quality analyzer for a technical team. Given meeting notes, rate their quality from 1 to 10 and provide actionable improvement suggestions. Evaluate based on these criteria:
- Are decisions clearly stated with owners?
- Are action items specific, assigned, and have deadlines?
- Are code references resolvable (file paths, not vague)?
- Are open questions properly flagged?
- Is the summary comprehensive?
- Is there proper speaker attribution?

Also extract metrics: count of decisions, action items, code references, and open questions.

Respond ONLY with valid JSON in this exact format: {"score": <number>, "suggestions": ["suggestion1", "suggestion2", ...], "meetingMetrics": {"decisions": <number>, "actionItems": <number>, "codeReferences": <number>, "openQuestions": <number>}}`,
      messages: [
        {
          role: 'user',
          content: `Analyze the quality of these meeting notes:\n\n${content}`,
        },
      ],
    });

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip code fences
    text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

    // Try to extract JSON object from response
    const jsonMatch = text.match(
      /\{[\s\S]*"score"\s*:[\s\S]*"suggestions"\s*:[\s\S]*"meetingMetrics"\s*:[\s\S]*\}/,
    );
    const jsonCandidate = jsonMatch ? jsonMatch[0] : text;

    try {
      const parsed = JSON.parse(jsonCandidate) as {
        score: number;
        suggestions: string[];
        meetingMetrics: {
          decisions: number;
          actionItems: number;
          codeReferences: number;
          openQuestions: number;
        };
      };
      return {
        score: typeof parsed.score === 'number' ? parsed.score : 5,
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        meetingMetrics: {
          decisions: parsed.meetingMetrics?.decisions ?? 0,
          actionItems: parsed.meetingMetrics?.actionItems ?? 0,
          codeReferences: parsed.meetingMetrics?.codeReferences ?? 0,
          openQuestions: parsed.meetingMetrics?.openQuestions ?? 0,
        },
      };
    } catch {
      const scoreMatch = text.match(/(\d+)\s*\/\s*10/);
      return {
        score: scoreMatch ? parseInt(scoreMatch[1], 10) : 5,
        suggestions: [text],
        meetingMetrics: { decisions: 0, actionItems: 0, codeReferences: 0, openQuestions: 0 },
      };
    }
  },

  async applyMeetingSuggestions(
    content: string,
    suggestions: string[],
  ): Promise<string> {
    const ai = requireClient();

    const suggestionList = suggestions
      .map((s, i) => `${i + 1}. ${s}`)
      .join('\n');

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        'You are an expert meeting notes editor. Given meeting notes and a list of improvement suggestions, apply all the suggested improvements to the content. Return ONLY the updated markdown content. Do not wrap the output in code fences. Do not include any explanations — just the raw updated markdown.',
      messages: [
        {
          role: 'user',
          content: `Here are the meeting notes:\n\n${content}\n\n---\n\nApply these improvements:\n${suggestionList}`,
        },
      ],
    });

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip leading/trailing triple backticks if AI wraps output
    text = text.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```$/, '');

    return text;
  },

  async generateNewsArticle(
    topic: string,
    context?: string,
  ): Promise<{ headline: string; content: string; summary: string }> {
    const ai = requireClient();

    const contextBlock = context
      ? `\n\nAdditional research context and source material:\n${context}`
      : '';

    const response = await ai.messages.create({
      model: MODEL_FAST,
      max_tokens: 4096,
      system:
        `You are a seasoned tabloid news journalist writing for a major metropolitan newspaper like the New York Post. Your writing style is:

- **Headlines**: Bold, punchy, attention-grabbing headlines using wordplay, puns, or dramatic flair. Short and impactful.
- **Lead paragraph**: The most newsworthy fact in the first sentence. Who, what, when, where — front-loaded.
- **Tone**: Direct, conversational, slightly irreverent. You write with personality and attitude. Use active voice throughout.
- **Structure**: Inverted pyramid — most important information first, supporting details follow, background at the end.
- **Paragraphs**: Keep paragraphs to 1-3 sentences maximum. Short, punchy, scannable.
- **Quotes**: Include at least 2-3 attributed quotes (you may fabricate realistic placeholder quotes marked with [placeholder]).
- **Word choice**: Vivid, concrete language. Prefer strong verbs over adverbs. Avoid jargon.
- **Length**: 400-800 words for a standard article.

Also provide a 1-2 sentence summary suitable for a social media post or article preview.

Respond ONLY with valid JSON in this exact format:
{"headline": "<attention-grabbing headline>", "content": "<full article in markdown>", "summary": "<1-2 sentence preview>"}`,
      messages: [
        {
          role: 'user',
          content: `Write a New York Post style news article about the following topic:\n\n${topic}${contextBlock}`,
        },
      ],
    });

    let text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    // Strip code fences
    text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

    try {
      const parsed = JSON.parse(text) as {
        headline: string;
        content: string;
        summary: string;
      };
      return {
        headline: parsed.headline || 'Breaking News',
        content: parsed.content || text,
        summary: parsed.summary || '',
      };
    } catch {
      return { headline: 'Breaking News', content: text, summary: '' };
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
      model: MODEL_FAST,
      max_tokens: 4096,
      system:
        `You are a technical documentation expert helping teams progress through their product lifecycle. ${seedPrompt} Write the output as a well-structured markdown document. Start with a # Title heading on the first line.`,
      messages: [
        {
          role: 'user',
          content: `Generate the next-stage document from this source:\n\n${content}`,
        },
      ],
    });

    const text =
      (response.content[0].type === 'text' ? response.content[0].text : '').trim();

    // Extract the title from the first # heading
    const headingMatch = text.match(/^#\s+(.+)$/m);
    return {
      title: headingMatch ? headingMatch[1].trim() : 'Untitled Document',
      content: text,
    };
  },
};
