import { describe, it, expect, vi, beforeEach } from 'vitest';
import { githubService, GitHubTokenExpiredError } from '../../services/github.service.js';

// We need to mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('GitHubTokenExpiredError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('listRepos throws GitHubTokenExpiredError on 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(githubService.listRepos('expired_token')).rejects.toThrow(GitHubTokenExpiredError);
  });

  it('listRepos throws generic error on other failures', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    await expect(githubService.listRepos('some_token')).rejects.toThrow('GitHub listRepos failed');
    await expect(githubService.listRepos('some_token')).rejects.not.toThrow(GitHubTokenExpiredError);
  });

  it('createIssue throws GitHubTokenExpiredError on 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(
      githubService.createIssue('expired_token', 'owner', 'repo', 'title', 'body'),
    ).rejects.toThrow(GitHubTokenExpiredError);
  });

  it('getFileTree throws GitHubTokenExpiredError on 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(
      githubService.getFileTree('expired_token', 'owner', 'repo'),
    ).rejects.toThrow(GitHubTokenExpiredError);
  });

  it('listIssues throws GitHubTokenExpiredError on 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(
      githubService.listIssues('expired_token', 'owner', 'repo'),
    ).rejects.toThrow(GitHubTokenExpiredError);
  });

  it('deleteWebhook throws GitHubTokenExpiredError on 401', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    await expect(
      githubService.deleteWebhook('expired_token', 'owner', 'repo', 123),
    ).rejects.toThrow(GitHubTokenExpiredError);
  });
});
