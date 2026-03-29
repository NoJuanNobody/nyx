import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockFetch } from '../helpers/setup.js';
import { bitbucketService, BitbucketTokenExpiredError } from '../../services/bitbucket.service.js';

describe('Bitbucket Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listRepos', () => {
    it('returns normalized repos from Bitbucket API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          values: [
            {
              uuid: '{abc-123}',
              name: 'my-repo',
              full_name: 'workspace/my-repo',
              is_private: true,
              links: { html: { href: 'https://bitbucket.org/workspace/my-repo' } },
              mainbranch: { name: 'main' },
            },
          ],
        }),
      } as any);

      const repos = await bitbucketService.listRepos('test-token');

      expect(repos).toHaveLength(1);
      expect(repos[0].fullName).toBe('workspace/my-repo');
      expect(repos[0].isPrivate).toBe(true);
      expect(repos[0].defaultBranch).toBe('main');
    });

    it('throws BitbucketTokenExpiredError on 401', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' } as any);

      await expect(bitbucketService.listRepos('bad-token')).rejects.toThrow(BitbucketTokenExpiredError);
    });
  });

  describe('createIssue', () => {
    it('creates an issue and returns normalized response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          id: 15,
          title: 'New feature',
          links: { html: { href: 'https://bitbucket.org/workspace/repo/issues/15' } },
          state: 'new',
        }),
      } as any);

      const issue = await bitbucketService.createIssue('token', 'workspace', 'repo', 'New feature', 'Details');

      expect(issue.id).toBe(15);
      expect(issue.number).toBe(15);
      expect(issue.title).toBe('New feature');
      expect(issue.htmlUrl).toContain('/issues/15');
    });
  });

  describe('createWebhook', () => {
    it('creates a webhook and returns the hook uuid', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ uuid: '{hook-uuid}' }),
      } as any);

      const hook = await bitbucketService.createWebhook('token', 'ws', 'repo', 'https://nyx.io/webhook', 'secret');

      expect(hook.id).toBe('{hook-uuid}');
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.events).toContain('repo:push');
    });
  });

  describe('exchangeCodeForToken', () => {
    it('throws on error response from Bitbucket', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ error: 'invalid_grant', error_description: 'Code expired' }),
      } as any);

      await expect(
        bitbucketService.exchangeCodeForToken('client-id', 'client-secret', 'bad-code'),
      ).rejects.toThrow('Code expired');
    });

    it('throws when no access_token in response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      } as any);

      await expect(
        bitbucketService.exchangeCodeForToken('client-id', 'client-secret', 'code'),
      ).rejects.toThrow('no access_token');
    });

    it('uses Basic auth for token exchange', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: 'bb-token',
          token_type: 'bearer',
          scopes: 'repository',
          refresh_token: 'bb-refresh',
        }),
      } as any);

      const result = await bitbucketService.exchangeCodeForToken('cid', 'cs', 'code');

      expect(result.access_token).toBe('bb-token');
      expect(result.refresh_token).toBe('bb-refresh');

      // Verify Basic auth header
      const authHeader = mockFetch.mock.calls[0][1].headers.Authorization;
      expect(authHeader).toContain('Basic ');
    });
  });

  describe('getAuthenticatedUser', () => {
    it('returns normalized user data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          username: 'bbuser',
          uuid: '{user-123}',
          display_name: 'BB User',
          links: { avatar: { href: 'https://bitbucket.org/avatar.png' } },
        }),
      } as any);

      const user = await bitbucketService.getAuthenticatedUser('token');

      expect(user.login).toBe('bbuser');
      expect(user.id).toBe('{user-123}');
      expect(user.name).toBe('BB User');
      expect(user.avatarUrl).toContain('avatar.png');
    });
  });

  describe('deleteWebhook', () => {
    it('succeeds silently on 404', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' } as any);

      await expect(bitbucketService.deleteWebhook('token', 'ws', 'repo', '{hook-id}')).resolves.toBeUndefined();
    });
  });

  describe('getFileContent', () => {
    it('fetches file content and base64 encodes it', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue('console.log("hello");'),
      } as any);

      const file = await bitbucketService.getFileContent('token', 'ws', 'repo', 'src/index.ts', 'main');

      expect(file.name).toBe('index.ts');
      expect(file.path).toBe('src/index.ts');
      expect(file.encoding).toBe('base64');
      expect(Buffer.from(file.content, 'base64').toString()).toBe('console.log("hello");');
    });
  });
});
