import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockFetch } from '../helpers/setup.js';
import { githubService } from '../../services/github.service.js';

describe('GitHub Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handlePushWebhook: extracts branch, commits, deduplicates changed files', () => {
    const payload = {
      ref: 'refs/heads/main',
      commits: [
        {
          id: 'abc123',
          message: 'Fix bug',
          timestamp: '2025-01-01T00:00:00Z',
          author: { name: 'Dev', email: 'dev@test.com' },
          added: ['src/new.ts'],
          removed: [],
          modified: ['src/app.ts'],
        },
        {
          id: 'def456',
          message: 'Update docs',
          timestamp: '2025-01-01T01:00:00Z',
          author: { name: 'Dev', email: 'dev@test.com' },
          added: [],
          removed: ['old.txt'],
          modified: ['src/app.ts'], // duplicate — should be deduped
        },
      ],
    };

    const result = githubService.handlePushWebhook(payload);

    expect(result.ref).toBe('refs/heads/main');
    expect(result.commits).toHaveLength(2);
    expect(result.changedFiles).toContain('src/new.ts');
    expect(result.changedFiles).toContain('src/app.ts');
    expect(result.changedFiles).toContain('old.txt');
    // Deduplicated: src/app.ts appears once
    expect(result.changedFiles.filter((f) => f === 'src/app.ts')).toHaveLength(1);
  });

  it('handlePushWebhook: handles empty commits array', () => {
    const result = githubService.handlePushWebhook({ ref: 'refs/heads/main', commits: [] });

    expect(result.commits).toHaveLength(0);
    expect(result.changedFiles).toHaveLength(0);
  });

  it('exchangeCodeForToken: throws on error response from GitHub', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ error: 'bad_verification_code', error_description: 'Code expired' }),
    } as any);

    await expect(
      githubService.exchangeCodeForToken('client-id', 'client-secret', 'bad-code'),
    ).rejects.toThrow('Code expired');
  });

  it('exchangeCodeForToken: throws when no access_token in response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    } as any);

    await expect(
      githubService.exchangeCodeForToken('client-id', 'client-secret', 'code'),
    ).rejects.toThrow('no access_token');
  });

  it('createWebhook: constructs correct payload with secret and events', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({ id: 12345 }),
    } as any);

    const result = await githubService.createWebhook(
      'ghp_token', 'myorg', 'myrepo', 'https://example.com/webhook', 'my-secret',
    );

    expect(result.id).toBe(12345);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/myorg/myrepo/hooks',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"secret":"my-secret"'),
      }),
    );

    // Verify the full payload structure
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.events).toEqual(['push']);
    expect(callBody.config.url).toBe('https://example.com/webhook');
    expect(callBody.config.content_type).toBe('json');
  });

  describe('createRepo', () => {
    it('creates a repo with correct payload and returns repo data', async () => {
      const repoResponse = {
        id: 99,
        name: 'new-repo',
        full_name: 'testuser/new-repo',
        private: true,
        html_url: 'https://github.com/testuser/new-repo',
        default_branch: 'main',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(repoResponse),
      } as any);

      const result = await githubService.createRepo(
        'ghp_token',
        'new-repo',
        'A test repo',
        true,
        true,
      );

      expect(result).toEqual(repoResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/user/repos',
        expect.objectContaining({
          method: 'POST',
        }),
      );

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.name).toBe('new-repo');
      expect(callBody.description).toBe('A test repo');
      expect(callBody.private).toBe(true);
      expect(callBody.auto_init).toBe(true);
    });

    it('uses default values when optional params are omitted', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 1, name: 'repo' }),
      } as any);

      await githubService.createRepo('ghp_token', 'repo');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.private).toBe(true);
      expect(callBody.auto_init).toBe(true);
      expect(callBody.description).toBe('');
    });

    it('throws GitHubTokenExpiredError on 401', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      } as any);

      await expect(
        githubService.createRepo('bad_token', 'repo'),
      ).rejects.toThrow('GitHub token expired');
    });

    it('throws descriptive error on 422 validation failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: vi.fn().mockResolvedValue({
          message: 'Validation Failed',
          errors: [{ message: 'name already exists on this account' }],
        }),
      } as any);

      await expect(
        githubService.createRepo('ghp_token', 'existing-repo'),
      ).rejects.toThrow('name already exists on this account');
    });

    it('throws generic error on other failures', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as any);

      await expect(
        githubService.createRepo('ghp_token', 'repo'),
      ).rejects.toThrow('GitHub createRepo failed: 500 Internal Server Error');
    });
  });
});
