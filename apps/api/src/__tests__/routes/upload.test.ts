import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeDocument } from '../helpers/factories.js';
import Fastify from 'fastify';
import { uploadRoutes } from '../../routes/upload.js';
import FormData from 'form-data';

// Mock permissions middleware to let requests through
vi.mock('../../middleware/permissions.js', () => ({
  requireRole: () => async () => {},
}));

// Mock file parser service so we can control return values
vi.mock('../../services/file-parser.service.js', () => ({
  fileParserService: {
    parseFile: vi.fn().mockReturnValue({ content: 'parsed content' }),
  },
}));

import { fileParserService } from '../../services/file-parser.service.js';

async function buildUploadApp() {
  const app = Fastify({ logger: false });

  // Decorate request with a test user
  app.decorateRequest('user', null as any);
  app.addHook('preHandler', async (request) => {
    request.user = {
      id: 'user-1',
      clerkId: null,
      email: 'test@test.com',
      name: 'Test User',
      avatarUrl: null,
      role: 'editor',
    } as any;
  });

  app.register(uploadRoutes, { prefix: '/api/documents' });
  await app.ready();
  return app;
}

function createMultipartPayload(filename: string, content: string, contentType: string) {
  const form = new FormData();
  form.append('file', Buffer.from(content), {
    filename,
    contentType,
  });
  return form;
}

describe('Upload Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /api/documents/:id/upload appends parsed content to document', async () => {
    const doc = makeDocument({ content: 'Existing content' });
    const updatedDoc = { ...doc, content: 'Existing content\n\n---\n\nparsed content' };

    // Mock select for document lookup
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([doc]),
      }),
    } as any);

    // Mock update for appending content
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedDoc]),
        }),
      }),
    } as any);

    const app = await buildUploadApp();
    const form = createMultipartPayload('test.txt', 'Hello world', 'text/plain');

    const res = await app.inject({
      method: 'POST',
      url: `/api/documents/${doc.id}/upload`,
      payload: form.getBuffer(),
      headers: form.getHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.document).toBeDefined();
    expect(fileParserService.parseFile).toHaveBeenCalled();
  });

  it('returns 404 when document does not exist', async () => {
    // Mock select returning empty
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    const app = await buildUploadApp();
    const form = createMultipartPayload('test.txt', 'Hello world', 'text/plain');

    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/nonexistent-id/upload',
      payload: form.getBuffer(),
      headers: form.getHeaders(),
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Document not found');
  });

  it('returns 400 when no file is uploaded', async () => {
    const app = await buildUploadApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/documents/some-id/upload',
      headers: { 'content-type': 'multipart/form-data; boundary=----test' },
      payload: '------test--\r\n',
    });

    expect(res.statusCode).toBe(400);
  });

  it('includes note in response when parser returns a note', async () => {
    const doc = makeDocument({ content: '' });
    const updatedDoc = { ...doc, content: 'parsed content' };

    vi.mocked(fileParserService.parseFile).mockReturnValue({
      content: 'parsed content',
      note: 'File type "application/pdf" is not fully supported.',
    });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([doc]),
      }),
    } as any);

    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedDoc]),
        }),
      }),
    } as any);

    const app = await buildUploadApp();
    const form = createMultipartPayload('file.pdf', 'pdf bytes', 'application/pdf');

    const res = await app.inject({
      method: 'POST',
      url: `/api/documents/${doc.id}/upload`,
      payload: form.getBuffer(),
      headers: form.getHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.note).toContain('not fully supported');
  });
});
