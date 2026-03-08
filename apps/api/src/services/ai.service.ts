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

export const aiService = {
  async analyzeSpecQuality(
    content: string,
  ): Promise<{ score: number; suggestions: string[] }> {
    const ai = requireClient();

    const response = await ai.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system:
        'You are a technical specification quality analyzer. Given a spec document, rate its quality from 1 to 10 and provide actionable improvement suggestions. Respond ONLY with valid JSON in this exact format: {"score": <number>, "suggestions": ["suggestion1", "suggestion2", ...]}',
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
};
