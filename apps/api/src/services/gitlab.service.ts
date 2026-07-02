// GitLab integration: repo listing, issue creation, webhook support (cloud + self-hosted)

import type {
  GitProvider,
  GitRepo,
  GitTreeEntry,
  GitFileContent,
  GitIssue,
  GitWebhook,
  GitUser,
  OAuthTokenResult,
} from './git-provider.interface.js';

const GITLAB_API = 'https://gitlab.com/api/v4';
const GITLAB_OAUTH = 'https://gitlab.com/oauth';

export class GitLabTokenExpiredError extends Error {
  constructor(method: string) {
    super(`GitLab token expired or revoked. Please reconnect your GitLab integration.`);
    this.name = 'GitLabTokenExpiredError';
  }
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function apiBase(baseUrl?: string): string {
  if (baseUrl) {
    return `${baseUrl.replace(/\/$/, '')}/api/v4`;
  }
  return GITLAB_API;
}

function oauthBase(baseUrl?: string): string {
  if (baseUrl) {
    return `${baseUrl.replace(/\/$/, '')}/oauth`;
  }
  return GITLAB_OAUTH;
}

export const gitlabService: GitProvider & {
  baseUrl?: string;
  setBaseUrl(url?: string): void;
  exchangeCodeForToken(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri?: string,
  ): Promise<OAuthTokenResult>;
} = {
  providerType: 'gitlab' as const,
  baseUrl: undefined,

  setBaseUrl(url?: string) {
    this.baseUrl = url;
  },

  async listRepos(accessToken: string): Promise<GitRepo[]> {
    const res = await fetch(
      `${apiBase(this.baseUrl)}/projects?membership=true&per_page=100&order_by=updated_at`,
      { headers: headers(accessToken) },
    );

    if (!res.ok) {
      if (res.status === 401) throw new GitLabTokenExpiredError('listRepos');
      throw new Error(`GitLab listRepos failed: ${res.status} ${res.statusText}`);
    }

    const projects = (await res.json()) as Array<{
      id: number;
      name: string;
      path_with_namespace: string;
      visibility: string;
      web_url: string;
      default_branch: string;
    }>;

    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      fullName: p.path_with_namespace,
      isPrivate: p.visibility === 'private',
      htmlUrl: p.web_url,
      defaultBranch: p.default_branch ?? 'main',
    }));
  },

  async createRepo(
    accessToken: string,
    data: { name: string; description?: string; isPrivate?: boolean },
  ): Promise<{ id: number | string; name: string; fullName: string; htmlUrl: string; defaultBranch: string }> {
    const res = await fetch(`${apiBase(this.baseUrl)}/projects`, {
      method: 'POST',
      headers: headers(accessToken),
      body: JSON.stringify({
        name: data.name,
        description: data.description ?? '',
        visibility: data.isPrivate ? 'private' : 'public',
        initialize_with_readme: true,
      }),
    });
    if (!res.ok) {
      if (res.status === 401) throw new GitLabTokenExpiredError('createRepo');
      const body = await res.text();
      throw new Error(`GitLab createRepo failed: ${res.status} ${body}`);
    }
    const project = (await res.json()) as {
      id: number;
      name: string;
      path_with_namespace: string;
      web_url: string;
      default_branch: string;
    };
    return {
      id: project.id,
      name: project.name,
      fullName: project.path_with_namespace,
      htmlUrl: project.web_url,
      defaultBranch: project.default_branch ?? 'main',
    };
  },

  async getFileTree(
    accessToken: string,
    owner: string,
    repo: string,
    ref = 'HEAD',
  ): Promise<GitTreeEntry[]> {
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const res = await fetch(
      `${apiBase(this.baseUrl)}/projects/${projectId}/repository/tree?recursive=true&per_page=100&ref=${ref}`,
      { headers: headers(accessToken) },
    );

    if (!res.ok) {
      if (res.status === 401) throw new GitLabTokenExpiredError('getFileTree');
      throw new Error(`GitLab getFileTree failed: ${res.status} ${res.statusText}`);
    }

    const entries = (await res.json()) as Array<{
      path: string;
      type: string;
    }>;

    return entries.map((e) => ({
      path: e.path,
      type: e.type === 'blob' ? 'blob' : 'tree',
    }));
  },

  async getFileContent(
    accessToken: string,
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<GitFileContent> {
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const filePath = encodeURIComponent(path);
    const url = new URL(`${apiBase(this.baseUrl)}/projects/${projectId}/repository/files/${filePath}`);
    if (ref) url.searchParams.set('ref', ref);
    else url.searchParams.set('ref', 'HEAD');

    const res = await fetch(url.toString(), { headers: headers(accessToken) });

    if (!res.ok) {
      if (res.status === 401) throw new GitLabTokenExpiredError('getFileContent');
      throw new Error(`GitLab getFileContent failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      file_name: string;
      file_path: string;
      size: number;
      content: string;
      encoding: string;
    };

    const base = this.baseUrl ?? 'https://gitlab.com';
    return {
      name: data.file_name,
      path: data.file_path,
      size: data.size,
      content: data.content,
      encoding: data.encoding,
      htmlUrl: `${base}/${owner}/${repo}/-/blob/${ref ?? 'HEAD'}/${path}`,
    };
  },

  async createIssue(
    accessToken: string,
    owner: string,
    repo: string,
    title: string,
    body: string,
    labels?: string[],
  ): Promise<GitIssue> {
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const res = await fetch(`${apiBase(this.baseUrl)}/projects/${projectId}/issues`, {
      method: 'POST',
      headers: headers(accessToken),
      body: JSON.stringify({
        title,
        description: body,
        labels: labels?.join(','),
      }),
    });

    if (!res.ok) {
      if (res.status === 401) throw new GitLabTokenExpiredError('createIssue');
      throw new Error(`GitLab createIssue failed: ${res.status} ${res.statusText}`);
    }

    const issue = (await res.json()) as {
      id: number;
      iid: number;
      title: string;
      web_url: string;
      state: string;
    };

    return {
      id: issue.id,
      iid: issue.iid,
      title: issue.title,
      htmlUrl: issue.web_url,
      state: issue.state,
    };
  },

  async listIssues(
    accessToken: string,
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'all',
  ): Promise<GitIssue[]> {
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const glState = state === 'all' ? 'all' : state === 'open' ? 'opened' : 'closed';
    const res = await fetch(
      `${apiBase(this.baseUrl)}/projects/${projectId}/issues?state=${glState}&per_page=100`,
      { headers: headers(accessToken) },
    );

    if (!res.ok) {
      if (res.status === 401) throw new GitLabTokenExpiredError('listIssues');
      throw new Error(`GitLab listIssues failed: ${res.status} ${res.statusText}`);
    }

    const issues = (await res.json()) as Array<{
      id: number;
      iid: number;
      title: string;
      web_url: string;
      state: string;
    }>;

    return issues.map((i) => ({
      id: i.id,
      iid: i.iid,
      title: i.title,
      htmlUrl: i.web_url,
      state: i.state,
    }));
  },

  async createWebhook(
    token: string,
    owner: string,
    repo: string,
    webhookUrl: string,
    secret: string,
  ): Promise<GitWebhook> {
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const res = await fetch(`${apiBase(this.baseUrl)}/projects/${projectId}/hooks`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        url: webhookUrl,
        token: secret,
        push_events: true,
        issues_events: true,
        enable_ssl_verification: true,
      }),
    });

    if (!res.ok) {
      if (res.status === 401) throw new GitLabTokenExpiredError('createWebhook');
      throw new Error(`GitLab createWebhook failed: ${res.status} ${res.statusText}`);
    }

    const hook = (await res.json()) as { id: number };
    return { id: hook.id };
  },

  async deleteWebhook(
    token: string,
    owner: string,
    repo: string,
    hookId: number | string,
  ): Promise<void> {
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const res = await fetch(
      `${apiBase(this.baseUrl)}/projects/${projectId}/hooks/${hookId}`,
      { method: 'DELETE', headers: headers(token) },
    );

    if (!res.ok && res.status !== 404) {
      if (res.status === 401) throw new GitLabTokenExpiredError('deleteWebhook');
      throw new Error(`GitLab deleteWebhook failed: ${res.status} ${res.statusText}`);
    }
  },

  async exchangeCodeForToken(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri?: string,
  ): Promise<OAuthTokenResult> {
    const res = await fetch(`${oauthBase(this.baseUrl)}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    if (!res.ok) {
      throw new Error(`GitLab token exchange failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      scope?: string;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };

    if (data.error) {
      throw new Error(`GitLab OAuth error: ${data.error_description || data.error}`);
    }
    if (!data.access_token) {
      throw new Error('GitLab token exchange returned no access_token');
    }

    return {
      access_token: data.access_token,
      token_type: data.token_type ?? 'bearer',
      scope: data.scope ?? '',
      refresh_token: data.refresh_token,
    };
  },

  async getAuthenticatedUser(accessToken: string): Promise<GitUser> {
    const res = await fetch(`${apiBase(this.baseUrl)}/user`, {
      headers: headers(accessToken),
    });

    if (!res.ok) {
      if (res.status === 401) throw new GitLabTokenExpiredError('getAuthenticatedUser');
      throw new Error(`GitLab getUser failed: ${res.status} ${res.statusText}`);
    }

    const user = (await res.json()) as {
      username: string;
      id: number;
      avatar_url: string;
      name: string;
    };

    return {
      login: user.username,
      id: user.id,
      avatarUrl: user.avatar_url,
      name: user.name,
    };
  },
};
