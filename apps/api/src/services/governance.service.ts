import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiService } from './ai.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve project root (apps/api/src/services -> project root)
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
  /(?:secret|token|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /(?:sk|pk)[-_](?:live|test)[-_][A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{36,}/,
  /xoxb-[A-Za-z0-9\-]+/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
];

function readAgentPolicyFile(filename: string): unknown | null {
  try {
    const filePath = path.join(PROJECT_ROOT, '.agentpolicy', filename);
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function detectSecrets(content: string): string[] {
  const violations: string[] = [];
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      violations.push(`Content matches secret pattern: ${pattern.source}`);
    }
  }
  return violations;
}

function checkPrincipleViolations(
  action: string,
  content?: string,
): string[] {
  const warnings: string[] = [];
  const constitution = readAgentPolicyFile('constitution.json') as {
    principles?: Array<{ id: string; title: string; description: string }>;
  } | null;

  if (!constitution?.principles) return warnings;

  // Check security-first principle
  if (content) {
    const secretViolations = detectSecrets(content);
    if (secretViolations.length > 0) {
      warnings.push(
        'Potential violation of "Security First" principle: content may contain secrets',
      );
    }
  }

  // Check scope-discipline for delete actions
  if (action === 'delete') {
    warnings.push(
      'Deletion actions should be reviewed against "Stay Scoped and Respect Sequencing" principle',
    );
  }

  return warnings;
}

export const governanceService = {
  async validateAction(params: {
    action: string;
    content?: string;
    stage?: string;
    teamId: string;
  }): Promise<{ allowed: boolean; violations: string[]; warnings: string[] }> {
    const { action, content, stage, teamId: _teamId } = params;
    const violations: string[] = [];
    const warnings: string[] = [];

    // Rule 1: publish action with content — quality gate
    if (action === 'publish' && content) {
      try {
        const quality = await aiService.analyzeSpecQuality(content, stage);
        if (quality.score < 7) {
          violations.push(
            `Quality score ${quality.score}/10 is below the minimum threshold of 7. Suggestions: ${quality.suggestions.join('; ')}`,
          );
        }
      } catch (err) {
        warnings.push(
          `Could not run quality analysis: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    }

    // Rule 2: edit/create — check for secrets in content
    if ((action === 'edit' || action === 'create') && content) {
      const secretViolations = detectSecrets(content);
      violations.push(...secretViolations);
    }

    // Rule 3: delete — require admin-level intent
    if (action === 'delete') {
      violations.push(
        'Delete actions require admin-level authorization. Ensure the requesting context has admin privileges.',
      );
    }

    // Always check principle violations as warnings
    const principleWarnings = checkPrincipleViolations(action, content);
    warnings.push(...principleWarnings);

    return {
      allowed: violations.length === 0,
      violations,
      warnings,
    };
  },

  getRules(): { constitution: unknown; governance: unknown } {
    const constitution = readAgentPolicyFile('constitution.json');
    const governance = readAgentPolicyFile('governance.json');
    return { constitution, governance };
  },

  detectSecrets,
};
