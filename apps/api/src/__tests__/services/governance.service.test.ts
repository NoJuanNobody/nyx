import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the ai.service module before importing governance service
vi.mock('../../services/ai.service.js', () => ({
  aiService: {
    analyzeSpecQuality: vi.fn(),
  },
}));

// Mock fs to control .agentpolicy file reading
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn((filePath: string, _encoding: string) => {
        if (filePath.includes('constitution.json')) {
          return JSON.stringify({
            principles: [
              {
                id: 'security-first',
                priority: 1,
                title: 'Security First',
                description: 'Never expose secrets.',
                enforceable: true,
              },
              {
                id: 'scope-discipline',
                priority: 4,
                title: 'Stay Scoped',
                description: 'Stay within scope.',
                enforceable: true,
              },
            ],
          });
        }
        if (filePath.includes('governance.json')) {
          return JSON.stringify({
            autonomy: { default_level: 'autonomous' },
            forbidden_paths: [{ pattern: '.env', reason: 'Secrets' }],
          });
        }
        throw new Error('File not found');
      }),
    },
  };
});

import { governanceService } from '../../services/governance.service.js';
import { aiService } from '../../services/ai.service.js';

const mockAnalyzeSpecQuality = vi.mocked(aiService.analyzeSpecQuality);

describe('Governance Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('detectSecrets', () => {
    it('detects API keys', () => {
      const content = 'const apiKey = "sk-live-abc123def456ghi789jkl012mno345"';
      const violations = governanceService.detectSecrets(content);
      expect(violations.length).toBeGreaterThan(0);
    });

    it('detects AWS access keys', () => {
      const content = 'aws_key = AKIAIOSFODNN7EXAMPLE';
      const violations = governanceService.detectSecrets(content);
      expect(violations.length).toBeGreaterThan(0);
    });

    it('detects GitHub personal access tokens', () => {
      const content = 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
      const violations = governanceService.detectSecrets(content);
      expect(violations.length).toBeGreaterThan(0);
    });

    it('detects JWTs', () => {
      const content =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const violations = governanceService.detectSecrets(content);
      expect(violations.length).toBeGreaterThan(0);
    });

    it('detects private keys', () => {
      const content = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...';
      const violations = governanceService.detectSecrets(content);
      expect(violations.length).toBeGreaterThan(0);
    });

    it('returns empty array for safe content', () => {
      const content = 'This is a normal document about product features.';
      const violations = governanceService.detectSecrets(content);
      expect(violations).toEqual([]);
    });

    it('detects Slack tokens', () => {
      const content = 'SLACK_TOKEN=xoxb-123456789-abcdefghij';
      const violations = governanceService.detectSecrets(content);
      expect(violations.length).toBeGreaterThan(0);
    });
  });

  describe('validateAction', () => {
    it('blocks publish when quality score is below 7', async () => {
      mockAnalyzeSpecQuality.mockResolvedValue({
        score: 4,
        suggestions: ['Add more detail', 'Include acceptance criteria'],
      });

      const result = await governanceService.validateAction({
        action: 'publish',
        content: 'A thin spec with no detail.',
        teamId: 'team-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0]).toContain('Quality score 4/10');
      expect(mockAnalyzeSpecQuality).toHaveBeenCalledWith(
        'A thin spec with no detail.',
        undefined,
      );
    });

    it('allows publish when quality score is 7 or above', async () => {
      mockAnalyzeSpecQuality.mockResolvedValue({
        score: 8,
        suggestions: [],
      });

      const result = await governanceService.validateAction({
        action: 'publish',
        content: 'A well-written specification with all sections.',
        teamId: 'team-1',
      });

      expect(result.allowed).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('passes stage to quality analysis', async () => {
      mockAnalyzeSpecQuality.mockResolvedValue({
        score: 9,
        suggestions: [],
      });

      await governanceService.validateAction({
        action: 'publish',
        content: 'Detailed spec.',
        stage: 'definition',
        teamId: 'team-1',
      });

      expect(mockAnalyzeSpecQuality).toHaveBeenCalledWith(
        'Detailed spec.',
        'definition',
      );
    });

    it('blocks edit action when content contains secrets', async () => {
      const result = await governanceService.validateAction({
        action: 'edit',
        content: 'Set api_key = "sk-live-supersecretkey1234567890abcdef"',
        teamId: 'team-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0]).toContain('secret pattern');
    });

    it('blocks create action when content contains secrets', async () => {
      const result = await governanceService.validateAction({
        action: 'create',
        content: 'token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"',
        teamId: 'team-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });

    it('allows edit action with clean content', async () => {
      const result = await governanceService.validateAction({
        action: 'edit',
        content: 'Updated the requirements section with new user stories.',
        teamId: 'team-1',
      });

      expect(result.allowed).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('blocks delete actions (requires admin intent)', async () => {
      const result = await governanceService.validateAction({
        action: 'delete',
        teamId: 'team-1',
      });

      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0]).toContain('admin-level');
    });

    it('returns warnings for principle violations on delete', async () => {
      const result = await governanceService.validateAction({
        action: 'delete',
        teamId: 'team-1',
      });

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('Scoped');
    });

    it('warns when quality analysis fails (e.g., no API key)', async () => {
      mockAnalyzeSpecQuality.mockRejectedValue(
        new Error('ANTHROPIC_API_KEY is not configured'),
      );

      const result = await governanceService.validateAction({
        action: 'publish',
        content: 'Some content.',
        teamId: 'team-1',
      });

      // Should not block — just warn
      expect(result.allowed).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('Could not run quality analysis');
    });

    it('allows publish without content (no quality check)', async () => {
      const result = await governanceService.validateAction({
        action: 'publish',
        teamId: 'team-1',
      });

      expect(result.allowed).toBe(true);
      expect(mockAnalyzeSpecQuality).not.toHaveBeenCalled();
    });
  });

  describe('getRules', () => {
    it('returns constitution and governance objects', () => {
      const rules = governanceService.getRules();
      expect(rules.constitution).toBeDefined();
      expect(rules.governance).toBeDefined();
      expect((rules.constitution as { principles: unknown[] }).principles).toBeDefined();
      expect((rules.governance as { forbidden_paths: unknown[] }).forbidden_paths).toBeDefined();
    });
  });
});
