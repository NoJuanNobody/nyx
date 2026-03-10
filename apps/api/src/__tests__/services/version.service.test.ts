import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockDb } from '../helpers/setup.js';
import { makeVersion, makeDocument } from '../helpers/factories.js';
import { versionService } from '../../services/version.service.js';

describe('Version Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('first version for doc → version number = 1', async () => {
    const doc = makeDocument();
    const newVersion = makeVersion({ documentId: doc.id, version: 1 });

    // Mock: latest version query returns empty
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as any);

    // Mock: insert returns the new version
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([newVersion]),
      }),
    } as any);

    const result = await versionService.create({
      documentId: doc.id,
      content: 'content',
      createdById: 'user-1',
    });

    expect(result.version).toBe(1);
  });

  it('subsequent version increments from latest', async () => {
    const doc = makeDocument();
    const existingVersion = makeVersion({ documentId: doc.id, version: 3 });
    const newVersion = makeVersion({ documentId: doc.id, version: 4 });

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([existingVersion]),
          }),
        }),
      }),
    } as any);

    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([newVersion]),
      }),
    } as any);

    const result = await versionService.create({
      documentId: doc.id,
      content: 'new content',
      createdById: 'user-1',
    });

    expect(result.version).toBe(4);
  });

  it('restoreToVersion creates new version with restored content + updates document', async () => {
    const version = makeVersion({ version: 2, content: 'old content' });
    const restoredVersion = makeVersion({ version: 3, message: 'Restored to v2' });

    // getById mock
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([version]),
        }),
      }),
    } as any);

    // update document
    mockDb.update.mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    // create (latest version query)
    mockDb.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([version]),
          }),
        }),
      }),
    } as any);

    // create (insert)
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([restoredVersion]),
      }),
    } as any);

    const result = await versionService.restoreToVersion(version.documentId, version.id, 'user-1');
    expect(result.message).toBe('Restored to v2');
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('diff returns null when version not found', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const result = await versionService.diff('nonexistent-a', 'nonexistent-b');
    expect(result).toBeNull();
  });

  it('getById returns null for non-existent ID', async () => {
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const result = await versionService.getById('nonexistent');
    expect(result).toBeNull();
  });
});
