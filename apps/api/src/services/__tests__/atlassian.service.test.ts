import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before import
vi.mock('../../lib/config.js', () => ({
  config: {
    ATLASSIAN_CLIENT_ID: 'test-client-id',
    ATLASSIAN_CLIENT_SECRET: 'test-client-secret',
    ENCRYPTION_SECRET: 'test-encryption-secret-for-vitest-32chars!',
    JIRA_WEBHOOK_SECRET: undefined,
  },
}));

// Mock the db module
vi.mock('../../db/index.js', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'test-id' }]),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

// Mock the schema
vi.mock('../../db/schema.js', () => ({
  atlassianConnections: {},
  pkceChallenges: { state: 'state', expiresAt: 'expires_at' },
  tickets: {},
  documents: {},
}));

// Mock encryption
vi.mock('../../lib/encryption.js', () => ({
  encrypt: (v: string) => `encrypted:${v}`,
  decrypt: (v: string) => v.replace('encrypted:', ''),
}));

import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateStateToken,
  textToAdf,
  adfToText,
  parseInlineMarks,
  atlassianService,
  validateJiraWebhookSignature,
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

    it('converts headings to ADF heading nodes', () => {
      const adf = textToAdf('# Heading 1\n\n## Heading 2\n\n### Heading 3') as {
        content: Array<{ type: string; attrs?: { level: number }; content: Array<{ text: string }> }>;
      };
      expect(adf.content).toHaveLength(3);
      expect(adf.content[0].type).toBe('heading');
      expect(adf.content[0].attrs?.level).toBe(1);
      expect(adf.content[0].content[0].text).toBe('Heading 1');
      expect(adf.content[1].attrs?.level).toBe(2);
      expect(adf.content[2].attrs?.level).toBe(3);
    });

    it('converts fenced code blocks to ADF codeBlock nodes', () => {
      const adf = textToAdf('```typescript\nconst x = 1;\nconsole.log(x);\n```') as {
        content: Array<{ type: string; attrs?: { language: string }; content: Array<{ text: string }> }>;
      };
      expect(adf.content).toHaveLength(1);
      expect(adf.content[0].type).toBe('codeBlock');
      expect(adf.content[0].attrs?.language).toBe('typescript');
      expect(adf.content[0].content[0].text).toBe('const x = 1;\nconsole.log(x);');
    });

    it('converts bullet lists to ADF bulletList nodes', () => {
      const adf = textToAdf('- Item one\n- Item two\n- Item three') as {
        content: Array<{ type: string; content: Array<{ type: string; content: Array<{ content: Array<{ text: string }> }> }> }>;
      };
      expect(adf.content).toHaveLength(1);
      expect(adf.content[0].type).toBe('bulletList');
      expect(adf.content[0].content).toHaveLength(3);
      expect(adf.content[0].content[0].type).toBe('listItem');
    });

    it('converts numbered lists to ADF orderedList nodes', () => {
      const adf = textToAdf('1. First\n2. Second\n3. Third') as {
        content: Array<{ type: string; content: Array<{ type: string }> }>;
      };
      expect(adf.content).toHaveLength(1);
      expect(adf.content[0].type).toBe('orderedList');
      expect(adf.content[0].content).toHaveLength(3);
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

    it('handles mixed content: headings, paragraphs, lists, code', () => {
      const markdown = '# Title\nSome intro\n- Item 1\n- Item 2\n```js\nalert(1)\n```';
      const adf = textToAdf(markdown) as { content: Array<{ type: string }> };
      const types = adf.content.map((n) => n.type);
      expect(types).toContain('heading');
      expect(types).toContain('paragraph');
      expect(types).toContain('bulletList');
      expect(types).toContain('codeBlock');
    });
  });

  describe('parseInlineMarks', () => {
    it('parses bold text', () => {
      const nodes = parseInlineMarks('Hello **bold** world') as Array<{
        text: string;
        marks?: Array<{ type: string }>;
      }>;
      expect(nodes).toHaveLength(3);
      expect(nodes[0].text).toBe('Hello ');
      expect(nodes[1].text).toBe('bold');
      expect(nodes[1].marks?.[0].type).toBe('strong');
      expect(nodes[2].text).toBe(' world');
    });

    it('parses italic text', () => {
      const nodes = parseInlineMarks('Hello *italic* world') as Array<{
        text: string;
        marks?: Array<{ type: string }>;
      }>;
      expect(nodes).toHaveLength(3);
      expect(nodes[1].text).toBe('italic');
      expect(nodes[1].marks?.[0].type).toBe('em');
    });

    it('parses inline code', () => {
      const nodes = parseInlineMarks('Run `npm install` now') as Array<{
        text: string;
        marks?: Array<{ type: string }>;
      }>;
      expect(nodes).toHaveLength(3);
      expect(nodes[1].text).toBe('npm install');
      expect(nodes[1].marks?.[0].type).toBe('code');
    });

    it('parses links', () => {
      const nodes = parseInlineMarks('Visit [Nyx](https://nyx.io)') as Array<{
        text: string;
        marks?: Array<{ type: string; attrs?: { href: string } }>;
      }>;
      expect(nodes).toHaveLength(2);
      expect(nodes[1].text).toBe('Nyx');
      expect(nodes[1].marks?.[0].type).toBe('link');
      expect(nodes[1].marks?.[0].attrs?.href).toBe('https://nyx.io');
    });

    it('returns plain text when no marks present', () => {
      const nodes = parseInlineMarks('Just plain text') as Array<{ text: string }>;
      expect(nodes).toHaveLength(1);
      expect(nodes[0].text).toBe('Just plain text');
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

    it('converts headings back to markdown', () => {
      const adf = {
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ text: 'My Heading' }] },
        ],
      };
      expect(adfToText(adf)).toBe('## My Heading');
    });

    it('converts code blocks back to markdown', () => {
      const adf = {
        content: [
          { type: 'codeBlock', attrs: { language: 'js' }, content: [{ text: 'alert(1)' }] },
        ],
      };
      expect(adfToText(adf)).toBe('```js\nalert(1)\n```');
    });

    it('converts bullet lists back to markdown', () => {
      const adf = {
        content: [
          {
            type: 'bulletList',
            content: [
              { content: [{ content: [{ text: 'Item A' }] }] },
              { content: [{ content: [{ text: 'Item B' }] }] },
            ],
          },
        ],
      };
      expect(adfToText(adf)).toBe('- Item A\n- Item B');
    });

    it('converts ordered lists back to markdown', () => {
      const adf = {
        content: [
          {
            type: 'orderedList',
            content: [
              { content: [{ content: [{ text: 'First' }] }] },
              { content: [{ content: [{ text: 'Second' }] }] },
            ],
          },
        ],
      };
      expect(adfToText(adf)).toBe('1. First\n2. Second');
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

  // ── Webhook Signature Validation ───────────────────────────

  describe('validateJiraWebhookSignature', () => {
    it('returns true when no secret is configured (dev mode)', () => {
      // Config mock has JIRA_WEBHOOK_SECRET = undefined
      expect(validateJiraWebhookSignature('{"test":true}', undefined)).toBe(true);
    });

    it('returns true when no secret is configured even with a signature', () => {
      expect(validateJiraWebhookSignature('{"test":true}', 'abc123')).toBe(true);
    });
  });

  // ── PKCE Store ─────────────────────────────────────────────

  describe('PKCE state management (DB-backed)', () => {
    it('getPkceData returns null for unknown state', async () => {
      const result = await atlassianService.getPkceData('nonexistent-state');
      expect(result).toBeNull();
    });
  });
});
