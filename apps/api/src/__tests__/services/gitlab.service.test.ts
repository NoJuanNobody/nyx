import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockFetch } from '../helpers/setup.js';
import { gitlabService, GitLabTokenExpiredError } from '../../services/gitlab.service.js';

describe('GitLab Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitlabService.setBaseUrl(undefined);
  });

  describe('listRepos', () => {
    it('returns normalized repos from GitLab API', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([
          {
            id: 1,
            name: 'my-project',
            path_with_namespace: 'user/my-project',
            visibility: 'private',
            web_url: 'https://gitlab.com/user/my-project',
            default_branch: 'main',
          },
        ]),
      } as any);

      const repos = await gitlabService.listRepos('test-token');

      expect(repos).toHaveLength(1);
      expect(repos[0].fullName).toBe('user/my-project');
      expect(repos[0].isPrivate).toBe(true);
      expect(repos[0].htmlUrl).toBe('https://gitlab.com/user/my-project');
    });

    it('throws GitLabTokenExpiredError on 401', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' } as any);

      await expect(gitlabService.listRepos('bad-token')).rejects.toThrow(GitLabTokenExpiredError);
    });
  });

  describe('createIssue', () => {
    it('creates an issue and returns normalized response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          id: 42,
          iid: 7,
          title: 'Bug fix',
          web_url: 'https://gitlab.com/user/repo/-/issues/7',
          state: 'opened',
        }),
      } as any);

      const issue = await gitlabService.createIssue('token', 'user', 'repo', 'Bug fix', 'Description', ['bug']);

      expect(issue.id).toBe(42);
      expect(issue.iid).toBe(7);
      expect(issue.title).toBe('Bug fix');
      expect(issue.htmlUrl).toContain('/issues/7');

      // Verify the request body includes labels
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.labels).toBe('bug');
    });
  });

  describe('createWebhook', () => {
    it('creates a webhook and returns the hook id', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 999 }),
      } as any);

      const hook = await gitlabService.createWebhook('token', 'user', 'repo', 'https://nyx.io/webhook', 'secret');

      expect(hook.id).toBe(999);
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.push_events).toBe(true);
      expect(callBody.url).toBe('https://nyx.io/webhook');
    });
  });

  describe('exchangeCodeForToken', () => {
    it('throws on error response from GitLab', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ error: 'invalid_grant', error_description: 'Code expired' }),
      } as any);

      await expect(
        gitlabService.exchangeCodeForToken('client-id', 'client-secret', 'bad-code', 'http://redirect'),
      ).rejects.toThrow('Code expired');
    });

    it('throws when no access_token in response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      } as any);

      await expect(
        gitlabService.exchangeCodeForToken('client-id', 'client-secret', 'code', 'http://redirect'),
      ).rejects.toThrow('no access_token');
    });

    it('returns token data on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: 'gl-token',
          token_type: 'Bearer',
          scope: 'api',
          refresh_token: 'gl-refresh',
        }),
      } as any);

      const result = await gitlabService.exchangeCodeForToken('cid', 'cs', 'code', 'http://redir');

      expect(result.access_token).toBe('gl-token');
      expect(result.refresh_token).toBe('gl-refresh');
    });
  });

  describe('getAuthenticatedUser', () => {
    it('returns normalized user data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          username: 'gluser',
          id: 123,
          avatar_url: 'https://gitlab.com/avatar.png',
          name: 'GL User',
        }),
      } as any);

      const user = await gitlabService.getAuthenticatedUser('token');

      expect(user.login).toBe('gluser');
      expect(user.id).toBe(123);
      expect(user.name).toBe('GL User');
    });
  });

  describe('self-hosted GitLab', () => {
    it('uses custom base URL when set', async () => {
      gitlabService.setBaseUrl('https://gitlab.mycompany.com');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([]),
      } as any);

      await gitlabService.listRepos('token');

      expect(mockFetch.mock.calls[0][0]).toContain('https://gitlab.mycompany.com/api/v4');

      // Reset
      gitlabService.setBaseUrl(undefined);
    });
  });

  describe('deleteWebhook', () => {
    it('succeeds silently on 404', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' } as any);

      await expect(gitlabService.deleteWebhook('token', 'user', 'repo', 123)).resolves.toBeUndefined();
    });
  });
});
