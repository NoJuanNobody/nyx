import { describe, it, expect } from 'vitest';
import { gatekeeperService } from '../gatekeeper.service.js';

const longContent = 'A'.repeat(100);
const shortContent = 'A'.repeat(50);

describe('gatekeeperService', () => {
  describe('evaluateGate', () => {
    // ── Happy path ──────────────────────────────────────────

    it('passes when content is sufficient and transition is valid', () => {
      const result = gatekeeperService.evaluateGate(
        { content: longContent, stage: 'conception' },
        'definition',
      );

      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(3);
      expect(result.checks.every((c) => c.passed)).toBe(true);
    });

    it('passes for sequential transitions through all stages', () => {
      const stages = ['conception', 'definition', 'architecture', 'implementation', 'execution'];

      for (let i = 0; i < stages.length - 1; i++) {
        const result = gatekeeperService.evaluateGate(
          { content: longContent, stage: stages[i] },
          stages[i + 1],
        );
        expect(result.passed).toBe(true);
      }
    });

    // ── Content checks ──────────────────────────────────────

    it('fails when content is empty', () => {
      const result = gatekeeperService.evaluateGate(
        { content: '', stage: 'conception' },
        'definition',
      );

      expect(result.passed).toBe(false);
      const emptyCheck = result.checks.find((c) => c.name === 'content_not_empty');
      expect(emptyCheck?.passed).toBe(false);
      expect(emptyCheck?.reason).toBe('Document content must not be empty');
    });

    it('fails when content is only whitespace', () => {
      const result = gatekeeperService.evaluateGate(
        { content: '   \n\t  ', stage: 'conception' },
        'definition',
      );

      expect(result.passed).toBe(false);
      const emptyCheck = result.checks.find((c) => c.name === 'content_not_empty');
      expect(emptyCheck?.passed).toBe(false);
    });

    it('fails when content is below minimum length', () => {
      const result = gatekeeperService.evaluateGate(
        { content: shortContent, stage: 'conception' },
        'definition',
      );

      expect(result.passed).toBe(false);
      const lengthCheck = result.checks.find((c) => c.name === 'minimum_content_length');
      expect(lengthCheck?.passed).toBe(false);
      expect(lengthCheck?.reason).toContain('at least 100 characters');
      expect(lengthCheck?.reason).toContain('currently 50');
    });

    it('passes when content is exactly minimum length', () => {
      const result = gatekeeperService.evaluateGate(
        { content: 'X'.repeat(100), stage: 'conception' },
        'definition',
      );

      const lengthCheck = result.checks.find((c) => c.name === 'minimum_content_length');
      expect(lengthCheck?.passed).toBe(true);
    });

    // ── Stage transition checks ─────────────────────────────

    it('fails when trying to move backward', () => {
      const result = gatekeeperService.evaluateGate(
        { content: longContent, stage: 'architecture' },
        'definition',
      );

      expect(result.passed).toBe(false);
      const transitionCheck = result.checks.find((c) => c.name === 'valid_stage_transition');
      expect(transitionCheck?.passed).toBe(false);
      expect(transitionCheck?.reason).toContain('Cannot move backward');
    });

    it('fails when trying to skip stages', () => {
      const result = gatekeeperService.evaluateGate(
        { content: longContent, stage: 'conception' },
        'architecture',
      );

      expect(result.passed).toBe(false);
      const transitionCheck = result.checks.find((c) => c.name === 'valid_stage_transition');
      expect(transitionCheck?.passed).toBe(false);
      expect(transitionCheck?.reason).toContain('Cannot skip stages');
      expect(transitionCheck?.reason).toContain('definition');
    });

    it('fails when trying to transition to the same stage', () => {
      const result = gatekeeperService.evaluateGate(
        { content: longContent, stage: 'definition' },
        'definition',
      );

      expect(result.passed).toBe(false);
      const transitionCheck = result.checks.find((c) => c.name === 'valid_stage_transition');
      expect(transitionCheck?.passed).toBe(false);
      expect(transitionCheck?.reason).toContain('Cannot move backward');
    });

    it('fails when target stage is unrecognized', () => {
      const result = gatekeeperService.evaluateGate(
        { content: longContent, stage: 'conception' },
        'nonexistent',
      );

      expect(result.passed).toBe(false);
      const transitionCheck = result.checks.find((c) => c.name === 'valid_stage_transition');
      expect(transitionCheck?.passed).toBe(false);
      expect(transitionCheck?.reason).toContain('not a recognized stage');
    });

    // ── Null current stage ──────────────────────────────────

    it('allows transition to first stage when current stage is null', () => {
      const result = gatekeeperService.evaluateGate(
        { content: longContent, stage: null },
        'conception',
      );

      expect(result.passed).toBe(true);
    });

    it('allows transition to any stage when current stage is null', () => {
      const result = gatekeeperService.evaluateGate(
        { content: longContent, stage: null },
        'definition',
      );

      expect(result.passed).toBe(true);
      const transitionCheck = result.checks.find((c) => c.name === 'valid_stage_transition');
      expect(transitionCheck?.passed).toBe(true);
    });

    // ── Custom stage order ──────────────────────────────────

    it('supports custom stage ordering', () => {
      const customOrder = ['draft', 'review', 'approved', 'published'];

      const result = gatekeeperService.evaluateGate(
        { content: longContent, stage: 'draft' },
        'review',
        customOrder,
      );

      expect(result.passed).toBe(true);
    });

    it('rejects skipping in custom stage order', () => {
      const customOrder = ['draft', 'review', 'approved', 'published'];

      const result = gatekeeperService.evaluateGate(
        { content: longContent, stage: 'draft' },
        'published',
        customOrder,
      );

      expect(result.passed).toBe(false);
      const transitionCheck = result.checks.find((c) => c.name === 'valid_stage_transition');
      expect(transitionCheck?.reason).toContain('Cannot skip stages');
    });

    // ── Unknown current stage (not in order) ────────────────

    it('allows transition when current stage is not in the known order', () => {
      const result = gatekeeperService.evaluateGate(
        { content: longContent, stage: 'custom-unknown' },
        'conception',
      );

      expect(result.passed).toBe(true);
    });

    // ── Multiple failures ───────────────────────────────────

    it('returns all failed checks, not just the first', () => {
      const result = gatekeeperService.evaluateGate(
        { content: '', stage: 'architecture' },
        'conception',
      );

      expect(result.passed).toBe(false);
      const failedChecks = result.checks.filter((c) => !c.passed);
      expect(failedChecks.length).toBeGreaterThanOrEqual(3);
    });
  });
});
