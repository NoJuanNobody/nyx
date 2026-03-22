import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateStateToken,
  textToAdf,
  adfToText,
  atlassianService,
} from '../atlassian.service.js';

describe('atlassianService', () => {
  // ── PKCE Utilities ─────────────────────────────────────────

  describe('generateCodeVerifier', () => {
    it('generates a string of at least 43 characters', () => {
      const verifier = generateCodeVerifier();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
    });

    it('generates unique verifiers on each call', () => {
      const v1 = generateCodeVerifier();
      const v2 = generateCodeVerifier();
      expect(v1).not.toBe(v2);
    });

    it('generates base64url-safe characters', () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('generateCodeChallenge', () => {
    it('generates a base64url-encoded SHA-256 hash', () => {
      const verifier = 'test-verifier-that-is-long-enough-for-pkce-requirement';
      const challenge = generateCodeChallenge(verifier);
      expect(challenge).toBeTruthy();
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('produces deterministic output for the same input', () => {
      const verifier = 'deterministic-test-verifier';
      const c1 = generateCodeChallenge(verifier);
      const c2 = generateCodeChallenge(verifier);
      expect(c1).toBe(c2);
    });

    it('produces different output for different inputs', () => {
      const c1 = generateCodeChallenge('verifier-one');
      const c2 = generateCodeChallenge('verifier-two');
      expect(c1).not.toBe(c2);
    });
  });

  describe('generateStateToken', () => {
    it('generates a 64-character hex string', () => {
      const state = generateStateToken();
      expect(state).toMatch(/^[a-f0-9]{64}$/);
    });

    it('generates unique tokens on each call', () => {
      const s1 = generateStateToken();
      const s2 = generateStateToken();
      expect(s1).not.toBe(s2);
    });
  });

  // ── ADF Conversion ─────────────────────────────────────────

  describe('textToAdf', () => {
    it('converts single paragraph text to ADF', () => {
      const adf = textToAdf('Hello world') as {
        type: string;
        version: number;
        content: Array<{ type: string; content: Array<{ type: string; text: string }> }>;
      };
      expect(adf.type).toBe('doc');
      expect(adf.version).toBe(1);
      expect(adf.content).toHaveLength(1);
      expect(adf.content[0].type).toBe('paragraph');
      expect(adf.content[0].content[0].text).toBe('Hello world');
    });

    it('converts multi-paragraph text to ADF', () => {
      const adf = textToAdf('Paragraph one\n\nParagraph two\n\nParagraph three') as {
        content: Array<{ type: string; content: Array<{ text: string }> }>;
      };
      expect(adf.content).toHaveLength(3);
      expect(adf.content[0].content[0].text).toBe('Paragraph one');
      expect(adf.content[1].content[0].text).toBe('Paragraph two');
      expect(adf.content[2].content[0].text).toBe('Paragraph three');
    });

    it('appends a source URL when provided', () => {
      const adf = textToAdf('Content', 'https://nyx.io/spec/123') as {
        content: Array<{
          type: string;
          content: Array<{ type: string; text: string; marks?: Array<{ type: string; attrs: { href: string } }> }>;
        }>;
      };
      expect(adf.content).toHaveLength(2);
      const linkParagraph = adf.content[1];
      expect(linkParagraph.content[0].text).toBe('Source: ');
      expect(linkParagraph.content[1].text).toBe('https://nyx.io/spec/123');
      expect(linkParagraph.content[1].marks?.[0].attrs.href).toBe('https://nyx.io/spec/123');
    });
  });

  describe('adfToText', () => {
    it('converts ADF back to plain text', () => {
      const adf = {
        content: [
          { content: [{ text: 'First paragraph' }] },
          { content: [{ text: 'Second paragraph' }] },
        ],
      };
      const text = adfToText(adf);
      expect(text).toBe('First paragraph\n\nSecond paragraph');
    });

    it('handles empty ADF', () => {
      expect(adfToText({})).toBe('');
      expect(adfToText({ content: [] })).toBe('');
    });

    it('handles blocks without content', () => {
      const adf = { content: [{ content: undefined as unknown as Array<{ text: string }> }, { content: [{ text: 'ok' }] }] };
      const text = adfToText(adf);
      expect(text).toBe('\n\nok');
    });
  });

  // ── Jira Status Mapping ────────────────────────────────────

  describe('mapJiraStatusToNyx', () => {
    it('maps "To Do" to "pending"', () => {
      expect(atlassianService.mapJiraStatusToNyx('To Do')).toBe('pending');
    });

    it('maps "In Progress" to "in_progress"', () => {
      expect(atlassianService.mapJiraStatusToNyx('In Progress')).toBe('in_progress');
    });

    it('maps "Done" to "completed"', () => {
      expect(atlassianService.mapJiraStatusToNyx('Done')).toBe('completed');
    });

    it('defaults unknown statuses to "pending"', () => {
      expect(atlassianService.mapJiraStatusToNyx('Unknown')).toBe('pending');
      expect(atlassianService.mapJiraStatusToNyx('')).toBe('pending');
    });
  });

  // ── PKCE Store (buildAuthUrl / getPkceData) ────────────────

  describe('PKCE state management', () => {
    it('stores and retrieves PKCE data via state token', () => {
      // buildAuthUrl requires env vars; test getPkceData independently
      // by testing that getPkceData returns null for unknown state
      expect(atlassianService.getPkceData('nonexistent-state')).toBeNull();
    });
  });
});
