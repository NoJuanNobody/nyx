import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockFetch } from '../helpers/setup.js';

const { mockAiService } = vi.hoisted(() => ({
  mockAiService: {
    bootstrapDocsFromCode: vi.fn(),
    bootstrapModuleDocs: vi.fn(),
    mergeModuleDocs: vi.fn(),
  },
}));

vi.mock('../../services/ai.service.js', () => ({
  aiService: mockAiService,
}));

import { onboardingService, groupFilesIntoModules, sampleFilesFromModule } from '../../services/onboarding.service.js';

describe('onboardingService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('scanRepository', () => {
    it('uses legacy single-prompt for small repos (< 5 files)', async () => {
      // Tree fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          tree: [
            { path: 'README.md', type: 'blob', size: 500 },
            { path: 'src/index.ts', type: 'blob', size: 1000 },
            { path: 'node_modules/lib.js', type: 'blob', size: 500 },
          ],
        }),
      });

      // File content fetches (README.md and src/index.ts — only 2 valid files)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          content: Buffer.from('# My Project').toString('base64'),
          encoding: 'base64',
        }),
      });
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
      expect(result.suggestedDocs).toBe('Generated documentation content');
      expect(mockAiService.bootstrapDocsFromCode).toHaveBeenCalled();
      // Should NOT have called module-level AI methods
      expect(mockAiService.bootstrapModuleDocs).not.toHaveBeenCalled();
      expect(mockAiService.mergeModuleDocs).not.toHaveBeenCalled();
    });

    it('uses smart sampling for repos with >= 5 files', async () => {
      // Tree with files in different module directories
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          tree: [
            { path: 'src/routes/auth.ts', type: 'blob', size: 2000 },
            { path: 'src/routes/users.ts', type: 'blob', size: 1500 },
            { path: 'src/services/auth.service.ts', type: 'blob', size: 3000 },
            { path: 'src/components/App.tsx', type: 'blob', size: 2000 },
            { path: 'src/db/schema.ts', type: 'blob', size: 4000 },
            { path: 'src/utils/helpers.ts', type: 'blob', size: 500 },
            { path: 'package.json', type: 'blob', size: 1000 },
          ],
        }),
      });

      // File content fetches for each sampled file
      for (let i = 0; i < 7; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue({
            content: Buffer.from(`// file content ${i}`).toString('base64'),
            encoding: 'base64',
          }),
        });
      }

      mockAiService.bootstrapModuleDocs.mockResolvedValue('Module docs');
      mockAiService.mergeModuleDocs.mockResolvedValueOnce('Merged docs');

      const result = await onboardingService.scanRepository(
        'ghp_token',
        'owner',
        'repo',
      );

      expect(result.suggestedDocs).toBe('Merged docs');
      expect(result.moduleDocs.length).toBeGreaterThan(0);
      expect(mockAiService.bootstrapModuleDocs).toHaveBeenCalled();
      expect(mockAiService.mergeModuleDocs).toHaveBeenCalled();
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

  describe('groupFilesIntoModules', () => {
    it('groups files by directory patterns', () => {
      const tree = [
        { path: 'src/routes/auth.ts', type: 'blob', size: 1000 },
        { path: 'src/services/user.service.ts', type: 'blob', size: 1000 },
        { path: 'src/components/App.tsx', type: 'blob', size: 1000 },
        { path: 'src/db/schema.ts', type: 'blob', size: 1000 },
        { path: 'src/middleware/auth.ts', type: 'blob', size: 1000 },
        { path: 'src/utils/helpers.ts', type: 'blob', size: 1000 },
        { path: 'package.json', type: 'blob', size: 500 },
      ];

      const modules = groupFilesIntoModules(tree);

      expect(modules.has('API Routes')).toBe(true);
      expect(modules.has('Services')).toBe(true);
      expect(modules.has('Components')).toBe(true);
      expect(modules.has('Data Layer')).toBe(true);
      expect(modules.has('Middleware')).toBe(true);
      expect(modules.has('Utilities')).toBe(true);
      expect(modules.has('Configuration')).toBe(true);
    });

    it('skips node_modules and build directories', () => {
      const tree = [
        { path: 'node_modules/react/index.js', type: 'blob', size: 100 },
        { path: 'dist/bundle.js', type: 'blob', size: 5000 },
        { path: 'src/index.ts', type: 'blob', size: 1000 },
      ];

      const modules = groupFilesIntoModules(tree);

      // Only src/index.ts should remain, in "Other" since it doesn't match any module pattern
      const totalFiles = [...modules.values()].reduce((sum, files) => sum + files.length, 0);
      expect(totalFiles).toBe(1);
    });

    it('puts unmatched files into "Other" bucket', () => {
      const tree = [
        { path: 'src/main.ts', type: 'blob', size: 1000 },
      ];

      const modules = groupFilesIntoModules(tree);
      expect(modules.has('Other')).toBe(true);
      expect(modules.get('Other')).toHaveLength(1);
    });

    it('removes empty modules', () => {
      const tree = [
        { path: 'src/routes/auth.ts', type: 'blob', size: 1000 },
      ];

      const modules = groupFilesIntoModules(tree);
      // Only API Routes should exist, all others should be removed
      expect(modules.has('API Routes')).toBe(true);
      expect(modules.has('Services')).toBe(false);
    });
  });

  describe('sampleFilesFromModule', () => {
    it('returns all files if under the limit', () => {
      const files = [
        { path: 'src/routes/auth.ts', type: 'blob', size: 1000 },
        { path: 'src/routes/users.ts', type: 'blob', size: 1000 },
      ];

      const sampled = sampleFilesFromModule(files, 8);
      expect(sampled).toHaveLength(2);
    });

    it('prioritizes index files', () => {
      const files = [
        { path: 'src/routes/index.ts', type: 'blob', size: 500 },
        { path: 'src/routes/auth.ts', type: 'blob', size: 500 },
        { path: 'src/routes/users.ts', type: 'blob', size: 500 },
        { path: 'src/routes/teams.ts', type: 'blob', size: 500 },
        { path: 'src/routes/docs.ts', type: 'blob', size: 500 },
        { path: 'src/routes/settings.ts', type: 'blob', size: 500 },
        { path: 'src/routes/admin.ts', type: 'blob', size: 500 },
        { path: 'src/routes/webhooks.ts', type: 'blob', size: 500 },
        { path: 'src/routes/export.ts', type: 'blob', size: 500 },
        { path: 'src/routes/import.ts', type: 'blob', size: 500 },
      ];

      const sampled = sampleFilesFromModule(files, 3);
      expect(sampled).toHaveLength(3);
      // index.ts should be included (highest priority)
      expect(sampled.some((f) => f.path?.includes('index.ts'))).toBe(true);
    });

    it('deprioritizes test files', () => {
      const files = [
        { path: 'src/routes/auth.ts', type: 'blob', size: 500 },
        { path: 'src/routes/auth.test.ts', type: 'blob', size: 500 },
        { path: 'src/routes/users.ts', type: 'blob', size: 500 },
      ];

      const sampled = sampleFilesFromModule(files, 2);
      expect(sampled).toHaveLength(2);
      // Test file should be excluded when limit is reached
      expect(sampled.some((f) => f.path?.includes('.test.'))).toBe(false);
    });
  });
});
