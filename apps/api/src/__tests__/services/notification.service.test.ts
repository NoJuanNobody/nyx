import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { notificationService } from '../../services/notification.service.js';

describe('NotificationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('creates notification when inApp preference is true (default)', async () => {
      const notification = {
        id: 'notif-1',
        userId: 'user-1',
        teamId: 'team-1',
        eventType: 'doc_edit',
        title: 'Document updated',
        body: 'Your doc was edited',
        metadata: null,
        entityId: null,
        readAt: null,
        createdAt: new Date(),
      };

      // Preferences query returns no rows (defaults apply — inApp is true)
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      // Insert returns the new notification
      mockDb.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([notification]),
        }),
      } as any);

      const result = await notificationService.create({
        userId: 'user-1',
        teamId: 'team-1',
        eventType: 'doc_edit',
        title: 'Document updated',
        body: 'Your doc was edited',
      });

      expect(result).toEqual(notification);
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('skips insert when inApp preference is false', async () => {
      // Preferences query returns a preference with inApp=false
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: 'pref-1',
              userId: 'user-1',
              eventType: 'doc_edit',
              inApp: false,
              emailEnabled: true,
              emailMode: 'daily',
              updatedAt: new Date(),
            },
          ]),
        }),
      } as any);

      const result = await notificationService.create({
        userId: 'user-1',
        teamId: 'team-1',
        eventType: 'doc_edit',
        title: 'Document updated',
      });

      expect(result).toBeNull();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('updates existing notification instead of inserting when grouping window applies', async () => {
      const existingNotification = {
        id: 'notif-existing',
        userId: 'user-1',
        teamId: 'team-1',
        eventType: 'doc_edit',
        title: 'Document updated',
        body: 'Old body',
        metadata: null,
        entityId: 'doc-123',
        readAt: null,
        createdAt: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
      };

      const updatedNotification = {
        ...existingNotification,
        body: 'New body',
        createdAt: new Date(),
      };

      // Preferences query returns no rows (defaults apply)
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      // Dedup query finds an existing unread notification within window
      mockDb.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([existingNotification]),
        }),
      } as any);

      // Update returns the updated notification
      mockDb.update.mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedNotification]),
          }),
        }),
      } as any);

      const result = await notificationService.create({
        userId: 'user-1',
        teamId: 'team-1',
        eventType: 'doc_edit',
        title: 'Document updated',
        body: 'New body',
        entityId: 'doc-123',
      });

      expect(result).toEqual(updatedNotification);
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });
});
