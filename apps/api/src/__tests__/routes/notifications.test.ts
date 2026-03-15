import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import Fastify from 'fastify';
import { notificationRoutes } from '../../routes/notifications.js';

const TEST_USER = {
  id: 'user-1',
  clerkId: 'clerk_1',
  email: 'test@test.com',
  name: 'Test User',
  avatarUrl: null,
  role: 'admin',
};

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = TEST_USER as any;
  });
  app.register(notificationRoutes, { prefix: '/api/notifications' });
  await app.ready();
  return app;
}

describe('Notification Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/notifications returns items with pagination', async () => {
    const now = new Date();
    const items = [
      { id: 'n1', userId: 'user-1', eventType: 'doc_edit', title: 'Doc edited', body: null, readAt: null, createdAt: now },
      { id: 'n2', userId: 'user-1', eventType: 'ticket_created', title: 'Ticket created', body: null, readAt: null, createdAt: now },
    ];

    // Mock for the list query
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(items),
          }),
        }),
      }),
    } as any);

    // Mock for the unread count query
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 2 }]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
    expect(body.unreadCount).toBe(2);
  });

  it('PATCH /api/notifications/:id/read sets readAt', async () => {
    const now = new Date();
    const updated = {
      id: 'n1',
      userId: 'user-1',
      eventType: 'doc_edit',
      title: 'Doc edited',
      body: null,
      readAt: now,
      createdAt: now,
    };

    mockDb.update.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updated]),
        }),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/notifications/n1/read',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.readAt).toBeDefined();
    expect(body.id).toBe('n1');
  });

  it('GET /api/notifications/unread-count returns correct count', async () => {
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ count: 5 }]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications/unread-count',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(5);
  });

  it('PATCH /api/notifications/:id/read returns 404 when not found', async () => {
    mockDb.update.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/notifications/nonexistent/read',
    });

    expect(res.statusCode).toBe(404);
  });

  it('DELETE /api/notifications/:id deletes notification', async () => {
    mockDb.delete.mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'n1' }]),
      }),
    } as any);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/notifications/n1',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });
});
