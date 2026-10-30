/**
 * Integration tests: Document lifecycle
 * Tests the full create -> read -> update -> version flow through the API layer.
 *
 * Unlike the unit-level route tests that test individual endpoints in isolation,
 * these tests verify multi-step flows where the output of one operation feeds
 * into the next — ensuring routes, services, and the (mocked) DB layer work
 * together correctly.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeDocument, makeUser, makeTeam, makeTeamMember, makeVersion } from '../helpers/factories.js';
import Fastify, { type FastifyInstance } from 'fastify';

// ── Mock permissions middleware ──────────────────────────────────────
vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

// ── Mock timeline + audit (fire-and-forget side effects) ────────────
vi.mock('../../services/timeline.service.js', () => ({
  timelineService: { create: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../services/audit.service.js', () => ({
  auditService: { recordEvent: vi.fn().mockResolvedValue({}) },
}));

// ── Mock version service (used by version routes) ───────────────────
const { mockVersionService } = vi.hoisted(() => ({
  mockVersionService: {
    listByDocument: vi.fn(),
    create: vi.fn(),
    getById: vi.fn(),
    diff: vi.fn(),
    restoreToVersion: vi.fn(),
  },
}));

vi.mock('../../services/version.service.js', () => ({
  versionService: mockVersionService,
}));

// ── Import routes after mocks are set up ────────────────────────────
import { documentRoutes } from '../../routes/documents.js';
import { documentVersionRoutes, versionRoutes } from '../../routes/versions.js';

// ── Test data ───────────────────────────────────────────────────────
const user = makeUser({ id: 'int-user-1', clerkId: 'clerk_int_1' });
const team = makeTeam({ id: 'int-team-1' });
const member = makeTeamMember({ userId: user.id, teamId: team.id, role: 'owner' });

/**
 * Build a Fastify app with document + version routes registered,
 * and a pre-handler that injects a test user (mimicking the auth middleware).
 */
async function buildIntegrationApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Decorate request with a test user — mirrors what authMiddleware does
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: user.id,
      clerkId: user.clerkId,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: 'owner',
    } as any;
  });

  // Register both document and version routes under the same prefixes as the real app
  app.register(documentRoutes, { prefix: '/api/documents' });
  app.register(documentVersionRoutes, { prefix: '/api/documents' });
  app.register(versionRoutes, { prefix: '/api/versions' });

  await app.ready();
  return app;
}

describe('Integration: Document Lifecycle', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildIntegrationApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ────────────────────────────────────────────────────────────────────
  // 1. Create a document, then fetch it by ID — both return consistent data
  // ────────────────────────────────────────────────────────────────────
  it('create then fetch returns consistent data', async () => {
    const doc = makeDocument({
      id: 'doc-lifecycle-1',
      title: 'Lifecycle Doc',
      content: '# Lifecycle\n\nFirst draft',
      teamId: team.id,
      createdById: user.id,
    });

    // Mock the insert for POST /api/documents
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([doc]),
      }),
    } as any);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { title: 'Lifecycle Doc', content: '# Lifecycle\n\nFirst draft', teamId: team.id },
    });

    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(created.id).toBe(doc.id);
    expect(created.title).toBe('Lifecycle Doc');

    // Mock the select for GET /api/documents/:id — return the same document
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([doc]),
      }),
    } as any);

    const fetchRes = await app.inject({
      method: 'GET',
      url: `/api/documents/${doc.id}`,
    });

    expect(fetchRes.statusCode).toBe(200);
    const fetched = JSON.parse(fetchRes.body);

    // The fetched document should match the created one
    expect(fetched.id).toBe(created.id);
    expect(fetched.title).toBe(created.title);
    expect(fetched.content).toBe(created.content);
    expect(fetched.teamId).toBe(created.teamId);
  });

  // ────────────────────────────────────────────────────────────────────
  // 2. Create a document, update its content, verify the update response
  // ────────────────────────────────────────────────────────────────────
  it('create then update reflects new content', async () => {
    const originalDoc = makeDocument({
      id: 'doc-lifecycle-2',
      title: 'Original Title',
      content: '# Original content',
      teamId: team.id,
      createdById: user.id,
    });

    // Mock insert for creation
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([originalDoc]),
      }),
    } as any);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { title: 'Original Title', content: '# Original content', teamId: team.id },
    });

    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);

    // Now update the document
    const updatedDoc = {
      ...originalDoc,
      title: 'Updated Title',
      content: '# Updated content\n\nWith more detail',
      updatedAt: new Date(),
    };

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedDoc]),
        }),
      }),
    } as any);

    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/documents/${originalDoc.id}`,
      payload: { title: 'Updated Title', content: '# Updated content\n\nWith more detail' },
    });

    expect(updateRes.statusCode).toBe(200);
    const updated = JSON.parse(updateRes.body);

    // Updated fields should differ from original
    expect(updated.id).toBe(created.id);
    expect(updated.title).toBe('Updated Title');
    expect(updated.content).toBe('# Updated content\n\nWith more detail');
    expect(updated.title).not.toBe(created.title);
  });

  // ────────────────────────────────────────────────────────────────────
  // 3. Create a document and create a version — version references doc
  // ────────────────────────────────────────────────────────────────────
  it('create a document then snapshot a version referencing it', async () => {
    const doc = makeDocument({
      id: 'doc-lifecycle-3',
      title: 'Versioned Doc',
      content: '# Version 1 content',
      teamId: team.id,
      createdById: user.id,
    });

    // Mock insert for document creation
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([doc]),
      }),
    } as any);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { title: 'Versioned Doc', content: '# Version 1 content', teamId: team.id },
    });

    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);

    // Now create a version for this document
    const version = makeVersion({
      id: 'ver-lifecycle-1',
      documentId: doc.id,
      version: 1,
      content: doc.content,
      message: 'Initial snapshot',
      createdById: user.id,
    });

    mockVersionService.create.mockResolvedValue(version);

    const versionRes = await app.inject({
      method: 'POST',
      url: `/api/documents/${doc.id}/versions`,
      payload: { content: doc.content, message: 'Initial snapshot' },
    });

    expect(versionRes.statusCode).toBe(201);
    const createdVersion = JSON.parse(versionRes.body);

    // Version should reference the parent document
    expect(createdVersion.documentId).toBe(created.id);
    expect(createdVersion.content).toBe(created.content);
    expect(createdVersion.version).toBe(1);
    expect(createdVersion.message).toBe('Initial snapshot');

    // Verify the version service was called with correct arguments
    expect(mockVersionService.create).toHaveBeenCalledWith({
      documentId: doc.id,
      content: doc.content,
      message: 'Initial snapshot',
      createdById: user.id,
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 4. List documents for a team — returns created documents
  // ────────────────────────────────────────────────────────────────────
  it('listing documents for a team returns the correct set', async () => {
    const doc1 = makeDocument({
      id: 'doc-list-1',
      title: 'First Doc',
      teamId: team.id,
      createdById: user.id,
      updatedAt: new Date('2025-01-02'),
    });
    const doc2 = makeDocument({
      id: 'doc-list-2',
      title: 'Second Doc',
      teamId: team.id,
      createdById: user.id,
      updatedAt: new Date('2025-01-03'),
    });

    // Mock insert for first document
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([doc1]),
      }),
    } as any);

    const create1Res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { title: 'First Doc', content: '# First', teamId: team.id },
    });
    expect(create1Res.statusCode).toBe(201);

    // Mock insert for second document
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([doc2]),
      }),
    } as any);

    const create2Res = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { title: 'Second Doc', content: '# Second', teamId: team.id },
    });
    expect(create2Res.statusCode).toBe(201);

    // Mock the select for listing — return both documents
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([doc1, doc2]),
      }),
    } as any);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/documents?teamId=${team.id}`,
    });

    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body);

    expect(list).toHaveLength(2);
    // Default sort is by updatedAt desc, so doc2 (newer) should come first
    expect(list[0].id).toBe(doc2.id);
    expect(list[1].id).toBe(doc1.id);
  });

  // ────────────────────────────────────────────────────────────────────
  // 5. Soft-delete a document — it no longer appears in the active list
  // ────────────────────────────────────────────────────────────────────
  it('soft-deleting a document excludes it from the active list', async () => {
    const doc = makeDocument({
      id: 'doc-archive-1',
      title: 'To Be Deleted',
      teamId: team.id,
      createdById: user.id,
    });

    // Create the document
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([doc]),
      }),
    } as any);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { title: 'To Be Deleted', content: '# Delete me', teamId: team.id },
    });
    expect(createRes.statusCode).toBe(201);

    // Soft delete via DELETE — sets deletedAt tombstone
    const now = new Date();
    const deletedDoc = { ...doc, deletedAt: now, updatedAt: now };

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([deletedDoc]),
        }),
      }),
    } as any);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/documents/${doc.id}`,
    });

    expect(deleteRes.statusCode).toBe(200);
    const deleted = JSON.parse(deleteRes.body);
    expect(deleted.deletedAt).toBeTruthy();

    // Now list documents — the route filters on isNull(deletedAt) at the SQL
    // layer, so the mock returns the empty active list.
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/documents?teamId=${team.id}`,
    });

    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body);
    // Soft-deleted documents are excluded by default
    expect(list).toHaveLength(0);

    // With includeDeleted=true (or legacy includeArchived=true), the route
    // skips the isNull filter and the mock returns the tombstoned row.
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([deletedDoc]),
      }),
    } as any);

    const listAllRes = await app.inject({
      method: 'GET',
      url: `/api/documents?teamId=${team.id}&includeDeleted=true`,
    });

    expect(listAllRes.statusCode).toBe(200);
    const listAll = JSON.parse(listAllRes.body);
    expect(listAll).toHaveLength(1);
    expect(listAll[0].deletedAt).toBeTruthy();
  });

  // ────────────────────────────────────────────────────────────────────
  // 6. Update a document then list its versions
  // ────────────────────────────────────────────────────────────────────
  it('after multiple versions, listing returns them all in order', async () => {
    const docId = 'doc-multi-ver';
    const doc = makeDocument({
      id: docId,
      title: 'Multi-Version Doc',
      content: '# v1',
      teamId: team.id,
      createdById: user.id,
    });

    // Create the document
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([doc]),
      }),
    } as any);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/documents',
      payload: { title: 'Multi-Version Doc', content: '# v1', teamId: team.id },
    });
    expect(createRes.statusCode).toBe(201);

    // Create version 1
    const v1 = makeVersion({
      id: 'ver-mv-1',
      documentId: docId,
      version: 1,
      content: '# v1',
      message: 'First version',
      createdById: user.id,
    });
    mockVersionService.create.mockResolvedValue(v1);

    const v1Res = await app.inject({
      method: 'POST',
      url: `/api/documents/${docId}/versions`,
      payload: { content: '# v1', message: 'First version' },
    });
    expect(v1Res.statusCode).toBe(201);

    // Update the document
    const updatedDoc = { ...doc, content: '# v2 content', updatedAt: new Date() };
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedDoc]),
        }),
      }),
    } as any);

    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/documents/${docId}`,
      payload: { content: '# v2 content' },
    });
    expect(updateRes.statusCode).toBe(200);

    // Create version 2
    const v2 = makeVersion({
      id: 'ver-mv-2',
      documentId: docId,
      version: 2,
      content: '# v2 content',
      message: 'Second version',
      createdById: user.id,
    });
    mockVersionService.create.mockResolvedValue(v2);

    const v2Res = await app.inject({
      method: 'POST',
      url: `/api/documents/${docId}/versions`,
      payload: { content: '# v2 content', message: 'Second version' },
    });
    expect(v2Res.statusCode).toBe(201);

    // List versions — should return both, newest first
    mockVersionService.listByDocument.mockResolvedValue([v2, v1]);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/documents/${docId}/versions`,
    });

    expect(listRes.statusCode).toBe(200);
    const versions = JSON.parse(listRes.body);

    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(2);
    expect(versions[1].version).toBe(1);
    expect(versions[0].documentId).toBe(docId);
    expect(versions[1].documentId).toBe(docId);

    // Verify the version service was called to list by the correct document
    expect(mockVersionService.listByDocument).toHaveBeenCalledWith(docId);
  });

  // ────────────────────────────────────────────────────────────────────
  // 7. Fetch a non-existent document returns 404
  // ────────────────────────────────────────────────────────────────────
  it('fetching a non-existent document returns 404', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const res = await app.inject({
      method: 'GET',
      url: '/api/documents/does-not-exist',
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
  });

  // ────────────────────────────────────────────────────────────────────
  // 8. Update a non-existent document returns 404
  // ────────────────────────────────────────────────────────────────────
  it('updating a non-existent document returns 404', async () => {
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/documents/nonexistent-id',
      payload: { title: 'Ghost' },
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
  });
});
