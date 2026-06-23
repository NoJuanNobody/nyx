/**
 * Spec compliance checking service — determines whether code
 * adheres to relevant specs stored in Nyx.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../lib/config.js';
import { retrieveChunks } from './retrieval.service.js';

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

export interface ComplianceViolation {
  rule: string;
  severity: 'error' | 'warning';
  description: string;
  specRef: string;
}

export interface ComplianceResult {
  compliant: boolean;
  violations: ComplianceViolation[];
}

/**
 * Check whether the given code content complies with the team's specs.
 * Uses vector retrieval to find relevant spec chunks, then asks Claude
 * to perform per-violation analysis.
 */
export async function checkCompliance(
  codeContent: string,
  teamId: string,
  filePath?: string,
): Promise<ComplianceResult> {
  const ai = requireClient();

  // Build a query from the code to find relevant specs
  const queryHint = filePath
    ? `Code from file "${filePath}":\n${codeContent.slice(0, 500)}`
    : codeContent.slice(0, 500);

  const chunks = await retrieveChunks(queryHint, teamId, { topK: 8, threshold: 0.2 });

  if (chunks.length === 0) {
    return { compliant: true, violations: [] };
  }

  const specContext = chunks
    .map((c, i) => `[Spec chunk ${i + 1} (doc ${c.docId}, score ${c.score.toFixed(2)})]\n${c.content}`)
    .join('\n\n---\n\n');

  const response = await ai.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: `You are a spec compliance checker for a software product. You are given a set of specification excerpts and a piece of code. Analyze whether the code violates any requirements, conventions, or constraints described in the specs.

For each violation found, classify its severity:
- "error": the code directly contradicts or fails to implement a spec requirement
- "warning": the code partially implements a requirement or deviates from a recommended pattern

Respond ONLY with valid JSON in this exact format:
{
  "compliant": <boolean>,
  "violations": [
    {
      "rule": "<short rule name>",
      "severity": "error" | "warning",
      "description": "<what the code does wrong and what the spec requires>",
      "specRef": "<which spec chunk the violation relates to, e.g. 'Spec chunk 1'>"
    }
  ]
}

If the code is fully compliant, return {"compliant": true, "violations": []}.
Only report genuine violations — do not invent issues.`,
    messages: [
      {
        role: 'user',
        content: `## Specifications\n${specContext}\n\n## Code${filePath ? ` (${filePath})` : ''}\n\`\`\`\n${codeContent}\n\`\`\``,
      },
    ],
  });

  let text = response.content[0].type === 'text' ? response.content[0].text : '';

  // Strip code fences
  text = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?\s*```/g, '').trim();

  // Extract JSON
  const jsonMatch = text.match(/\{[\s\S]*"compliant"\s*:[\s\S]*\}/);
  const jsonCandidate = jsonMatch ? jsonMatch[0] : text;

  try {
    const parsed = JSON.parse(jsonCandidate) as ComplianceResult;

    // Validate and normalize
    const violations = Array.isArray(parsed.violations)
      ? parsed.violations.filter(
          (v) =>
            typeof v.rule === 'string' &&
            ['error', 'warning'].includes(v.severity) &&
            typeof v.description === 'string',
        )
      : [];

    const hasErrors = violations.some((v) => v.severity === 'error');

    return {
      compliant: violations.length === 0,
      violations,
    };
  } catch {
    return { compliant: true, violations: [] };
  }
}
