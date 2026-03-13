// GitHub integration: repo scanning, webhook handling, issue creation

import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { integrations } from '../db/schema.js';

const GITHUB_API = 'https://api.github.com';

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// ── Response types ────────────────────────────────────

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
}

export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
  url: string;
}

export interface GitHubFileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  content: string;
  encoding: string;
  html_url: string;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: string;
}

export interface PushWebhookResult {
  ref: string;
  commits: Array<{
    id: string;
    message: string;
    timestamp: string;
    author: { name: string; email: string };
  }>;
  changedFiles: string[];
}

export class GitHubTokenExpiredError extends Error {
  constructor(method: string) {
    super(`GitHub token expired or revoked. Please reconnect your GitHub integration.`);
    this.name = 'GitHubTokenExpiredError';
  }
}

// ── Service ───────────────────────────────────────────

export const githubService = {
  async listRepos(accessToken: string): Promise<GitHubRepo[]> {
    const res = await fetch(`${GITHUB_API}/user/repos?per_page=100&sort=updated`, {
      headers: headers(accessToken),
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new GitHubTokenExpiredError('listRepos');
      }
      throw new Error(`GitHub listRepos failed: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as GitHubRepo[];
  },

  async getFileTree(
    accessToken: string,
    owner: string,
    repo: string,
    ref = 'HEAD',
  ): Promise<GitHubTreeEntry[]> {
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
      { headers: headers(accessToken) },
    );

    if (!res.ok) {
      if (res.status === 401) {
        throw new GitHubTokenExpiredError('getFileTree');
      }
      throw new Error(`GitHub getFileTree failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { tree: GitHubTreeEntry[] };
    return data.tree;
  },

  async getFileContent(
    accessToken: string,
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<GitHubFileContent> {
    const url = new URL(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`);
    if (ref) url.searchParams.set('ref', ref);

    const res = await fetch(url.toString(), {
      headers: headers(accessToken),
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new GitHubTokenExpiredError('getFileContent');
      }
      throw new Error(`GitHub getFileContent failed: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as GitHubFileContent;
  },

  async createIssue(
    accessToken: string,
    owner: string,
    repo: string,
    title: string,
    body: string,
    labels?: string[],
  ): Promise<GitHubIssue> {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: {
        ...headers(accessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, body, labels }),
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new GitHubTokenExpiredError('createIssue');
      }
      throw new Error(`GitHub createIssue failed: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as GitHubIssue;
  },

  async getGitHubTokenForTeam(teamId: string): Promise<string | null> {
    const [integration] = await db
      .select()
      .from(integrations)
      .where(and(eq(integrations.teamId, teamId), eq(integrations.type, 'github')));

    if (!integration) return null;
    const config = integration.config as { accessToken?: string };
    return config.accessToken ?? null;
  },

  async exchangeCodeForToken(
    clientId: string,
    clientSecret: string,
    code: string,
  ): Promise<{ access_token: string; token_type: string; scope: string }> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });

    if (!res.ok) {
      throw new Error(`GitHub token exchange failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { access_token?: string; token_type?: string; scope?: string; error?: string; error_description?: string };
    if (data.error) {
      throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
    }
    if (!data.access_token) {
      throw new Error('GitHub token exchange returned no access_token');
    }

    return { access_token: data.access_token, token_type: data.token_type ?? 'bearer', scope: data.scope ?? '' };
  },

  async getAuthenticatedUser(accessToken: string): Promise<{ login: string; id: number; avatar_url: string; name: string | null }> {
    const res = await fetch(`${GITHUB_API}/user`, {
      headers: headers(accessToken),
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new GitHubTokenExpiredError('getAuthenticatedUser');
      }
      throw new Error(`GitHub getUser failed: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as { login: string; id: number; avatar_url: string; name: string | null };
  },

  async createWebhook(
    token: string,
    owner: string,
    repo: string,
    webhookUrl: string,
    secret: string,
  ): Promise<{ id: number }> {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/hooks`, {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['push'],
        config: {
          url: webhookUrl,
          content_type: 'json',
          secret,
          insecure_ssl: '0',
        },
      }),
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new GitHubTokenExpiredError('createWebhook');
      }
      throw new Error(`GitHub createWebhook failed: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as { id: number };
  },

  async deleteWebhook(
    token: string,
    owner: string,
    repo: string,
    hookId: number,
  ): Promise<void> {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/hooks/${hookId}`, {
      method: 'DELETE',
      headers: headers(token),
    });

    if (!res.ok && res.status !== 404) {
      if (res.status === 401) {
        throw new GitHubTokenExpiredError('deleteWebhook');
      }
      throw new Error(`GitHub deleteWebhook failed: ${res.status} ${res.statusText}`);
    }
  },

  async listIssues(
    token: string,
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'all',
  ): Promise<GitHubIssue[]> {
    const res = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/issues?state=${state}&per_page=100`,
      { headers: headers(token) },
    );

    if (!res.ok) {
      if (res.status === 401) {
        throw new GitHubTokenExpiredError('listIssues');
      }
      throw new Error(`GitHub listIssues failed: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as GitHubIssue[];
  },

  async attachImageToIssue(
    token: string,
    owner: string,
    repo: string,
    issueNumber: number,
    imageBuffer: Buffer,
    filename: string,
  ): Promise<void> {
    // GitHub Issues don't support direct file attachments via API.
    // The workaround is to upload the image as a base64 data URL in a comment.
    const base64 = imageBuffer.toString('base64');
    const commentBody = `![${filename}](data:image/png;base64,${base64})\n\n_UI Mockup generated by SyncDocs_`;

    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: commentBody }),
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new GitHubTokenExpiredError('attachImageToIssue');
      }
      const body = await res.text();
      throw new Error(`GitHub API error ${res.status}: ${body}`);
    }
  },

  handlePushWebhook(payload: unknown): PushWebhookResult {
    const p = payload as {
      ref?: string;
      commits?: Array<{
        id: string;
        message: string;
        timestamp: string;
        author: { name: string; email: string };
        added?: string[];
        removed?: string[];
        modified?: string[];
      }>;
    };

    const ref = p.ref ?? '';
    const commits = (p.commits ?? []).map((c) => ({
      id: c.id,
      message: c.message,
      timestamp: c.timestamp,
      author: c.author,
    }));

    const changedFilesSet = new Set<string>();
    for (const commit of p.commits ?? []) {
      for (const f of commit.added ?? []) changedFilesSet.add(f);
      for (const f of commit.removed ?? []) changedFilesSet.add(f);
      for (const f of commit.modified ?? []) changedFilesSet.add(f);
    }

    return { ref, commits, changedFiles: [...changedFilesSet] };
  },
};
