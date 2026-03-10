import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeTeam, makeUser, makeTeamMember, makeInvitation } from '../helpers/factories.js';
import Fastify from 'fastify';
import { teamRoutes } from '../../routes/teams.js';

vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

async function buildTeamApp() {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: 'user-1',
      clerkId: null,
      email: 'test@test.com',
      name: 'Test User',
      avatarUrl: null,
      role: 'owner',
    } as any;
  });
  app.register(teamRoutes, { prefix: '/api/teams' });
  await app.ready();
  return app;
}

describe('Team Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/teams auto-provisions personal team when user has none', async () => {
    const team = makeTeam({ name: 'My Workspace' });

    // First select: no teams
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    // Insert team
    mockDb.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([team]),
      }),
    } as any);

    // Insert team member
    mockDb.insert.mockReturnValueOnce({
      values: vi.fn().mockResolvedValue(undefined),
    } as any);

    // Second select: now has team
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: team.id, name: 'My Workspace', slug: team.slug, role: 'owner' }]),
        }),
      }),
    } as any);

    const app = await buildTeamApp();
    const res = await app.inject({ method: 'GET', url: '/api/teams' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('My Workspace');
  });

  it('POST /:id/members with existing user email → adds directly, type: "added"', async () => {
    const existingUser = makeUser({ email: 'existing@test.com' });
    const member = makeTeamMember({ userId: existingUser.id });

    // user lookup
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([existingUser]),
        }),
      }),
    } as any);

    // already member check
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    // insert member
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([member]),
      }),
    } as any);

    const app = await buildTeamApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/teams/team-1/members',
      payload: { email: 'existing@test.com', role: 'developer' },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('added');
  });

  it('POST /:id/members with unknown email → creates invitation, type: "invited"', async () => {
    const invitation = makeInvitation();

    // user lookup: not found
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    // insert invitation
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([invitation]),
      }),
    } as any);

    const app = await buildTeamApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/teams/team-1/members',
      payload: { email: 'unknown@test.com' },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('invited');
  });

  it('POST /:id/members with duplicate email → 409', async () => {
    const existingUser = makeUser();
    const existingMember = makeTeamMember();

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([existingUser]),
        }),
      }),
    } as any);

    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([existingMember]),
        }),
      }),
    } as any);

    const app = await buildTeamApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/teams/team-1/members',
      payload: { email: existingUser.email },
    });

    expect(res.statusCode).toBe(409);
  });

  it('GET /:id/invitations lists pending invitations', async () => {
    const invitations = [makeInvitation(), makeInvitation()];

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(invitations),
      }),
    } as any);

    const app = await buildTeamApp();
    const res = await app.inject({ method: 'GET', url: '/api/teams/team-1/invitations' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.invitations).toHaveLength(2);
  });

  it('DELETE /:id/invitations/:invId removes invitation, returns 204', async () => {
    const invitation = makeInvitation();

    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([invitation]),
      }),
    } as any);

    const app = await buildTeamApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/teams/team-1/invitations/${invitation.id}`,
    });

    expect(res.statusCode).toBe(204);
  });

  it('DELETE non-existent invitation → 404', async () => {
    mockDb.delete.mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildTeamApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/teams/team-1/invitations/nonexistent',
    });

    expect(res.statusCode).toBe(404);
  });

  it('PATCH /:id/members/:userId updates role', async () => {
    const member = makeTeamMember({ role: 'admin' });

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([member]),
        }),
      }),
    } as any);

    const app = await buildTeamApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/teams/team-1/members/user-2',
      payload: { role: 'admin' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.role).toBe('admin');
  });
});
