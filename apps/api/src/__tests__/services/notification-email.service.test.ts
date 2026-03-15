import { describe, it, expect, vi } from 'vitest';
import { mockDb, mockFetch } from '../helpers/setup.js';

// Mock the email service
const mockSendEmail = vi.fn<() => Promise<boolean>>();
vi.mock('../../services/email.js', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...(args as [])),
}));

// Import after mocks
const { notificationEmailService, buildNotificationEmail, buildDigestEmail } =
  await import('../../services/notification-email.service.js');

// ── Helpers ──────────────────────────────────────────────────────

function makeNotification(overrides: Partial<{
  id: string;
  userId: string;
  title: string;
  body: string | null;
  eventType: string;
}> = {}) {
  return {
    id: 'notif-1',
    userId: 'user-1',
    title: 'Document updated',
    body: 'The spec has been edited.',
    eventType: 'doc_edit',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('NotificationEmailService', () => {
  describe('queueOrSend', () => {
    it('sends email immediately when emailMode is instant', async () => {
      mockSendEmail.mockResolvedValueOnce(true);

      await notificationEmailService.queueOrSend(
        makeNotification(),
        'user@example.com',
        { emailEnabled: true, emailMode: 'instant' },
      );

      // Should have called sendEmail
      expect(mockSendEmail).toHaveBeenCalledOnce();
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'user@example.com',
          subject: 'Document updated',
        }),
      );

      // Should have inserted a delivery log with status 'sent'
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('queues entry when emailMode is daily', async () => {
      await notificationEmailService.queueOrSend(
        makeNotification(),
        'user@example.com',
        { emailEnabled: true, emailMode: 'daily' },
      );

      // Should NOT have called sendEmail
      expect(mockSendEmail).not.toHaveBeenCalled();

      // Should have inserted a queued delivery log
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('queues entry when emailMode is weekly', async () => {
      await notificationEmailService.queueOrSend(
        makeNotification(),
        'user@example.com',
        { emailEnabled: true, emailMode: 'weekly' },
      );

      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('skips entirely when emailMode is off', async () => {
      await notificationEmailService.queueOrSend(
        makeNotification(),
        'user@example.com',
        { emailEnabled: true, emailMode: 'off' },
      );

      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('skips entirely when emailEnabled is false', async () => {
      await notificationEmailService.queueOrSend(
        makeNotification(),
        'user@example.com',
        { emailEnabled: false, emailMode: 'instant' },
      );

      expect(mockSendEmail).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('logs failed status when sendEmail returns false', async () => {
      mockSendEmail.mockResolvedValueOnce(false);

      await notificationEmailService.queueOrSend(
        makeNotification(),
        'user@example.com',
        { emailEnabled: true, emailMode: 'instant' },
      );

      expect(mockSendEmail).toHaveBeenCalledOnce();
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe('buildNotificationEmail', () => {
    it('returns HTML with title and body', () => {
      const html = buildNotificationEmail('Test Title', 'Test body text');
      expect(html).toContain('Test Title');
      expect(html).toContain('Test body text');
      expect(html).toContain('Nyx');
    });

    it('includes CTA button when url is provided', () => {
      const html = buildNotificationEmail('Title', 'Body', 'https://nyx.dev/doc/1', 'Open Doc');
      expect(html).toContain('https://nyx.dev/doc/1');
      expect(html).toContain('Open Doc');
    });
  });

  describe('buildDigestEmail', () => {
    it('groups items by eventType', () => {
      const html = buildDigestEmail([
        { title: 'Doc A edited', body: 'Changed section 1', eventType: 'doc_edit' },
        { title: 'Doc B edited', body: 'Changed section 2', eventType: 'doc_edit' },
        { title: 'Ticket created', body: 'New ticket #5', eventType: 'ticket_created' },
      ]);
      expect(html).toContain('Doc Edit (2)');
      expect(html).toContain('Ticket Created (1)');
      expect(html).toContain('Notification Digest');
    });
  });
});
