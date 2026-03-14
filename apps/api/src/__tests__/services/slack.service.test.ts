import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySlackSignature, processSlackMessage } from '../../services/slack.service.js';

describe('slack.service', () => {
  describe('verifySlackSignature', () => {
    const signingSecret = 'test-signing-secret';

    function createValidSignature(timestamp: string, body: string): string {
      const sigBasestring = `v0:${timestamp}:${body}`;
      return 'v0=' + createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');
    }

    it('returns true for valid signature', () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = 'token=abc&text=hello';
      const signature = createValidSignature(timestamp, body);

      expect(verifySlackSignature(signature, timestamp, body, signingSecret)).toBe(true);
    });

    it('returns false for invalid signature', () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = 'token=abc&text=hello';

      expect(verifySlackSignature('v0=invalid', timestamp, body, signingSecret)).toBe(false);
    });

    it('returns false for mismatched body', () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = 'token=abc&text=hello';
      const signature = createValidSignature(timestamp, body);

      expect(verifySlackSignature(signature, timestamp, 'different-body', signingSecret)).toBe(
        false,
      );
    });

    it('returns false for timestamp older than 5 minutes (replay attack)', () => {
      const oldTimestamp = String(Math.floor(Date.now() / 1000) - 400);
      const body = 'token=abc&text=hello';
      const signature = createValidSignature(oldTimestamp, body);

      expect(verifySlackSignature(signature, oldTimestamp, body, signingSecret)).toBe(false);
    });

    it('returns false for wrong signing secret', () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = 'token=abc&text=hello';
      const signature = createValidSignature(timestamp, body);

      expect(verifySlackSignature(signature, timestamp, body, 'wrong-secret')).toBe(false);
    });
  });

  describe('processSlackMessage', () => {
    it('returns a summary with source slack', async () => {
      const result = await processSlackMessage('hello world', 'team-1', 'user-1', 'channel-1');

      expect(result.source).toBe('slack');
      expect(result.summary).toContain('hello world');
      expect(result.summary).toContain('user-1');
      expect(result.summary).toContain('channel-1');
    });

    it('handles empty text', async () => {
      const result = await processSlackMessage('', 'team-1', 'user-1', 'channel-1');

      expect(result.source).toBe('slack');
      expect(result.summary).toBeDefined();
    });
  });
});
