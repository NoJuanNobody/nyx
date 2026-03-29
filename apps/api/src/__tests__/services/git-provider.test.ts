import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockFetch } from '../helpers/setup.js';
import { gitlabService } from '../../services/gitlab.service.js';
import { bitbucketService } from '../../services/bitbucket.service.js';
import type { GitProvider } from '../../services/git-provider.interface.js';

describe('GitProvider interface compliance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const providers: Array<{ name: string; service: GitProvider }> = [
    { name: 'GitLab', service: gitlabService },
    { name: 'Bitbucket', service: bitbucketService },
  ];

  for (const { name, service } of providers) {
    describe(name, () => {
      it('has the correct providerType', () => {
        expect(service.providerType).toBe(name.toLowerCase());
      });

      it('implements all required methods', () => {
        expect(typeof service.listRepos).toBe('function');
        expect(typeof service.getFileTree).toBe('function');
        expect(typeof service.getFileContent).toBe('function');
        expect(typeof service.createIssue).toBe('function');
        expect(typeof service.listIssues).toBe('function');
        expect(typeof service.createWebhook).toBe('function');
        expect(typeof service.deleteWebhook).toBe('function');
        expect(typeof service.exchangeCodeForToken).toBe('function');
        expect(typeof service.getAuthenticatedUser).toBe('function');
      });
    });
  }
});
