import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockFetch } from '../helpers/setup.js';

const { mockAiService } = vi.hoisted(() => ({
  mockAiService: {
    bootstrapDocsFromCode: vi.fn(),
  },
}));

vi.mock('../../services/ai.service.js', () => ({
  aiService: mockAiService,
}));

import { onboardingService } from '../../services/onboarding.service.js';

describe('onboardingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('scanRepository', () => {
    it('returns doc files found in the repo', async () => {
      // First call: getFileTree
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          tree: [
            { path: 'README.md', type: 'blob', size: 500 },
            { path: 'src/index.ts', type: 'blob', size: 1000 },
            { path: 'node_modules', type: 'tree' },
          ],
        }),
      });

      // Second call: fetchFileContent for README.md
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          content: Buffer.from('# My Project').toString('base64'),
          encoding: 'base64',
        }),
      });

      // Third call: fetchFileContent for src/index.ts
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          content: Buffer.from('export const main = () => {}').toString('base64'),
          encoding: 'base64',
        }),
      });

      mockAiService.bootstrapDocsFromCode.mockResolvedValueOnce(
        'Generated documentation content',
      );

      const result = await onboardingService.scanRepository(
        'ghp_token',
        'owner',
        'repo',
      );

      expect(result.files).toHaveLength(2);
      expect(result.files[0].path).toBe('README.md');
      expect(result.files[0].content).toBe('# My Project');
      expect(result.files[1].path).toBe('src/index.ts');
      expect(result.suggestedDocs).toBe('Generated documentation content');
      expect(mockAiService.bootstrapDocsFromCode).toHaveBeenCalledWith(
        result.files,
      );
    });

    it('handles empty file tree', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ tree: [] }),
      });

      mockAiService.bootstrapDocsFromCode.mockResolvedValueOnce('');

      const result = await onboardingService.scanRepository(
        'ghp_token',
        'owner',
        'repo',
      );

      expect(result.files).toHaveLength(0);
      expect(result.suggestedDocs).toBe('');
      // Only the tree fetch call should have been made, no file content calls
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('skips files that exceed size limit', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          tree: [
            { path: 'README.md', type: 'blob', size: 200_000 }, // Over 100KB limit
            { path: 'package.json', type: 'blob', size: 500 },
          ],
        }),
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          content: Buffer.from('{}').toString('base64'),
          encoding: 'base64',
        }),
      });

      mockAiService.bootstrapDocsFromCode.mockResolvedValueOnce('');

      const result = await onboardingService.scanRepository(
        'ghp_token',
        'owner',
        'repo',
      );

      // Only package.json should be included (README.md exceeds size limit)
      expect(result.files).toHaveLength(1);
      expect(result.files[0].path).toBe('package.json');
    });

    it('throws when GitHub API returns an error for tree fetch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(
        onboardingService.scanRepository('ghp_token', 'owner', 'repo'),
      ).rejects.toThrow('GitHub API error: 404 Not Found');
    });
  });
});
