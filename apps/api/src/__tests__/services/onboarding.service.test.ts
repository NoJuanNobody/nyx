import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockFetch } from '../helpers/setup.js';
import { onboardingService } from '../../services/onboarding.service.js';

vi.mock('../../services/ai.service.js', () => ({
  aiService: {
    bootstrapDocsFromCode: vi.fn().mockResolvedValue('# Generated Docs\n\nSome docs.'),
  },
}));

import { aiService } from '../../services/ai.service.js';

function makeTreeItem(overrides?: Record<string, unknown>) {
  return {
    type: 'blob',
    path: 'src/index.ts',
    size: 500,
    ...overrides,
  };
}

function makeFileContentResponse(content: string) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue({
      content: Buffer.from(content).toString('base64'),
      encoding: 'base64',
    }),
    text: vi.fn().mockResolvedValue(''),
  };
}

describe('Onboarding Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scans repository and returns files and suggested docs', async () => {
    const treeResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        tree: [
          makeTreeItem({ path: 'src/index.ts', size: 100 }),
          makeTreeItem({ path: 'README.md', size: 200 }),
        ],
      }),
      text: vi.fn().mockResolvedValue(''),
    };

    mockFetch
      .mockResolvedValueOnce(treeResponse)
      .mockResolvedValueOnce(makeFileContentResponse('export const x = 1;'))
      .mockResolvedValueOnce(makeFileContentResponse('# README'));

    const result = await onboardingService.scanRepository('token', 'owner', 'repo');

    expect(result.files).toHaveLength(2);
    expect(result.suggestedDocs).toBeDefined();
    expect(aiService.bootstrapDocsFromCode).toHaveBeenCalled();
  });

  it('filters only doc-relevant files', async () => {
    const treeResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        tree: [
          makeTreeItem({ path: 'src/index.ts' }),
          makeTreeItem({ path: 'README.md' }),
          makeTreeItem({ path: 'node_modules/foo/bar.js' }), // not relevant
          makeTreeItem({ path: 'dist/index.js' }), // not relevant
          makeTreeItem({ path: 'package.json' }),
        ],
      }),
      text: vi.fn().mockResolvedValue(''),
    };

    mockFetch
      .mockResolvedValueOnce(treeResponse)
      .mockResolvedValue(makeFileContentResponse('content'));

    await onboardingService.scanRepository('token', 'owner', 'repo');

    // fetch is called once for tree + once per relevant file (3: src/index.ts, README.md, package.json)
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('skips files over 100KB size limit', async () => {
    const treeResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        tree: [
          makeTreeItem({ path: 'src/index.ts', size: 100 }),
          makeTreeItem({ path: 'src/huge.ts', size: 200_000 }), // over limit
        ],
      }),
      text: vi.fn().mockResolvedValue(''),
    };

    mockFetch
      .mockResolvedValueOnce(treeResponse)
      .mockResolvedValue(makeFileContentResponse('small content'));

    await onboardingService.scanRepository('token', 'owner', 'repo');

    // Only 2 fetch calls: tree + small file (huge.ts is excluded)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('limits to 20 files maximum', async () => {
    const manyFiles = Array.from({ length: 30 }, (_, i) => ({
      type: 'blob',
      path: `src/file${i}.ts`,
      size: 100,
    }));

    const treeResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({ tree: manyFiles }),
      text: vi.fn().mockResolvedValue(''),
    };

    mockFetch
      .mockResolvedValueOnce(treeResponse)
      .mockResolvedValue(makeFileContentResponse('content'));

    const result = await onboardingService.scanRepository('token', 'owner', 'repo');

    expect(result.files.length).toBeLessThanOrEqual(20);
  });

  it('throws on GitHub API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: vi.fn(),
      text: vi.fn(),
    });

    await expect(
      onboardingService.scanRepository('token', 'owner', 'nonexistent-repo'),
    ).rejects.toThrow('GitHub API error');
  });

  it('passes fetched files to AI service', async () => {
    const treeResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        tree: [makeTreeItem({ path: 'src/app.ts', size: 100 })],
      }),
      text: vi.fn().mockResolvedValue(''),
    };

    mockFetch
      .mockResolvedValueOnce(treeResponse)
      .mockResolvedValueOnce(makeFileContentResponse('const app = {};'));

    await onboardingService.scanRepository('token', 'owner', 'repo');

    expect(aiService.bootstrapDocsFromCode).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/app.ts' }),
      ]),
    );
  });

  it('decodes base64 file content from GitHub API', async () => {
    const originalContent = 'export const greeting = "hello";';
    const treeResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: vi.fn().mockResolvedValue({
        tree: [makeTreeItem({ path: 'src/index.ts', size: 100 })],
      }),
      text: vi.fn().mockResolvedValue(''),
    };

    mockFetch
      .mockResolvedValueOnce(treeResponse)
      .mockResolvedValueOnce(makeFileContentResponse(originalContent));

    const result = await onboardingService.scanRepository('token', 'owner', 'repo');

    expect(result.files[0].content).toBe(originalContent);
  });
});
