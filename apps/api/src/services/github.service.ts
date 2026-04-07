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
      if (res.status === 403) {
        const body = await res.text();
        const isRateLimit = body.includes('rate limit') || res.headers.get('x-ratelimit-remaining') === '0';
        throw new Error(isRateLimit
          ? 'GitHub API rate limit exceeded. Please wait a few minutes and try again.'
          : `GitHub getFileTree forbidden (403): ${body.slice(0, 200)}`);
      }
      if (res.status === 404) {
        throw new Error('Repository not found or not accessible. Check that the repository exists and your GitHub token has access.');
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
      if (res.status === 403) {
        const body = await res.text();
        const isRateLimit = body.includes('rate limit') || res.headers.get('x-ratelimit-remaining') === '0';
        throw new Error(isRateLimit
          ? 'GitHub API rate limit exceeded. Please wait a few minutes and try again.'
          : `GitHub getFileContent forbidden (403): ${body.slice(0, 200)}`);
      }
      if (res.status === 404) {
        throw new Error(`File not found: "${path}". Check the path and try again.`);
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
    const commentBody = `![${filename}](data:image/png;base64,${base64})\n\n_UI Mockup generated by Nyx_`;

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

  // ── GitHub Projects v2 (GraphQL) ──────────────────────

  async graphql(token: string, query: string, variables?: Record<string, unknown>): Promise<unknown> {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      if (res.status === 401) throw new GitHubTokenExpiredError('graphql');
      throw new Error(`GitHub GraphQL failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
    if (data.errors?.length) {
      throw new Error(`GitHub GraphQL error: ${data.errors[0].message}`);
    }

    return data.data;
  },

  /**
   * List Projects v2 for a repository owner (user or org).
   */
  async listProjects(token: string, owner: string): Promise<Array<{ id: string; title: string; number: number }>> {
    // Try org first, fall back to user
    for (const ownerType of ['organization', 'user'] as const) {
      const query = `
        query($login: String!) {
          ${ownerType}(login: $login) {
            projectsV2(first: 20, orderBy: { field: UPDATED_AT, direction: DESC }) {
              nodes { id title number }
            }
          }
        }
      `;

      try {
        const data = (await this.graphql(token, query, { login: owner })) as Record<string, { projectsV2: { nodes: Array<{ id: string; title: string; number: number }> } }>;
        const result = data[ownerType];
        if (result?.projectsV2?.nodes) {
          return result.projectsV2.nodes;
        }
      } catch {
        continue;
      }
    }

    return [];
  },

  /**
   * Fetch items from a GitHub Project v2 board with their field values.
   * Returns issues/PRs with status, labels, and custom fields.
   */
  async getProjectItems(token: string, projectId: string): Promise<{
    title: string;
    items: Array<{
      id: string;
      contentId: string;
      title: string;
      number: number;
      status: string | null;
      labels: string[];
      url: string;
    }>;
    statusField: { id: string; options: Array<{ id: string; name: string }> } | null;
  }> {
    const query = `
      query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            title
            fields(first: 30) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options { id name }
                }
              }
            }
            items(first: 100) {
              nodes {
                id
                fieldValues(first: 20) {
                  nodes {
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field { ... on ProjectV2SingleSelectField { name } }
                    }
                  }
                }
                content {
                  ... on Issue {
                    id title number url
                    labels(first: 10) { nodes { name } }
                  }
                  ... on PullRequest {
                    id title number url
                    labels(first: 10) { nodes { name } }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data = (await this.graphql(token, query, { projectId })) as {
      node: {
        title: string;
        fields: { nodes: Array<{ id?: string; name?: string; options?: Array<{ id: string; name: string }> }> };
        items: { nodes: Array<{
          id: string;
          fieldValues: { nodes: Array<{ name?: string; field?: { name: string } }> };
          content: { id: string; title: string; number: number; url: string; labels?: { nodes: Array<{ name: string }> } } | null;
        }> };
      };
    };

    const project = data.node;
    const statusField = project.fields.nodes.find((f) => f.name === 'Status' && f.options);

    const items = project.items.nodes
      .filter((item) => item.content != null)
      .map((item) => {
        const statusValue = item.fieldValues.nodes.find((fv) => fv.field?.name === 'Status');
        return {
          id: item.id,
          contentId: item.content!.id,
          title: item.content!.title,
          number: item.content!.number,
          status: statusValue?.name ?? null,
          labels: item.content!.labels?.nodes.map((l) => l.name) ?? [],
          url: item.content!.url,
        };
      });

    return {
      title: project.title,
      items,
      statusField: statusField?.id && statusField?.options
        ? { id: statusField.id, options: statusField.options }
        : null,
    };
  },

  /**
   * Move a project item to a different status column.
   */
  async updateProjectItemStatus(
    token: string,
    projectId: string,
    itemId: string,
    statusFieldId: string,
    optionId: string,
  ): Promise<void> {
    const query = `
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: $value
        }) {
          projectV2Item { id }
        }
      }
    `;

    await this.graphql(token, query, {
      projectId,
      itemId,
      fieldId: statusFieldId,
      value: { singleSelectOptionId: optionId },
    });
  },

  async createRepo(
    accessToken: string,
    name: string,
    description?: string,
    isPrivate?: boolean,
    autoInit?: boolean,
  ): Promise<GitHubRepo> {
    const res = await fetch(`${GITHUB_API}/user/repos`, {
      method: 'POST',
      headers: {
        ...headers(accessToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        description: description ?? '',
        private: isPrivate ?? true,
        auto_init: autoInit ?? true,
      }),
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new GitHubTokenExpiredError('createRepo');
      }
      if (res.status === 422) {
        const body = (await res.json()) as { message?: string; errors?: Array<{ message: string }> };
        const detail = body.errors?.[0]?.message ?? body.message ?? 'Validation failed';
        throw new Error(`GitHub createRepo failed: ${detail}`);
      }
      throw new Error(`GitHub createRepo failed: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as GitHubRepo;
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
