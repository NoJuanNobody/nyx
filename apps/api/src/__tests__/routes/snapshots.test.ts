import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../helpers/setup.js';
import Fastify from 'fastify';

const { mockSnapshotService } = vi.hoisted(() => ({
  mockSnapshotService: {
    list: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    restore: vi.fn(),
  },
}));

vi.mock('../../services/snapshot.service.js', () => ({
  snapshotService: mockSnapshotService,
}));

import { snapshotRoutes } from '../../routes/snapshots.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: 'user-1',
      clerkId: 'clerk_1',
      email: 'test@test.com',
      name: 'Test User',
      avatarUrl: null,
      role: 'admin',
    } as any;
  });
  app.register(snapshotRoutes, { prefix: '/api/snapshots' });
  await app.ready();
  return app;
}

describe('Snapshot Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/snapshots returns snapshots', async () => {
    const snapshots = [{ id: 'snap-1', name: 'v1.0' }];
    mockSnapshotService.list.mockResolvedValue(snapshots);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/snapshots' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.snapshots).toHaveLength(1);
  });

  it('POST /api/snapshots creates snapshot and returns 201', async () => {
    const created = { id: 'snap-1', name: 'v1.0' };
    mockSnapshotService.create.mockResolvedValue(created);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/snapshots',
      payload: { name: 'v1.0', documentIds: ['doc-1'] },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.snapshots).toBeDefined();
  });

  it('GET /api/snapshots/:id returns snapshot', async () => {
    const snapshot = { id: 'snap-1', name: 'v1.0' };
    mockSnapshotService.getById.mockResolvedValue(snapshot);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/snapshots/snap-1' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('snap-1');
  });

  it('GET /api/snapshots/:id returns 404 when not found', async () => {
    mockSnapshotService.getById.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/snapshots/nonexistent' });

    expect(res.statusCode).toBe(404);
  });

  it('POST /api/snapshots/:id/restore returns result', async () => {
    const result = { restored: true, documentId: 'doc-1' };
    mockSnapshotService.restore.mockResolvedValue(result);

    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/snapshots/snap-1/restore' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.restored).toBe(true);
  });
});
