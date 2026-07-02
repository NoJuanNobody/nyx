// Bitbucket Cloud integration: repo listing, issue creation, webhook support

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

const BITBUCKET_API = 'https://api.bitbucket.org/2.0';
const BITBUCKET_AUTH = 'https://bitbucket.org/site/oauth2';

export class BitbucketTokenExpiredError extends Error {
  constructor(method: string) {
    super(`Bitbucket token expired or revoked. Please reconnect your Bitbucket integration.`);
    this.name = 'BitbucketTokenExpiredError';
  }
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export const bitbucketService: GitProvider & {
  exchangeCodeForToken(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri?: string,
  ): Promise<OAuthTokenResult>;
} = {
  providerType: 'bitbucket' as const,

  async listRepos(accessToken: string): Promise<GitRepo[]> {
    const res = await fetch(
      `${BITBUCKET_API}/repositories?role=member&pagelen=100&sort=-updated_on`,
      { headers: headers(accessToken) },
    );

    if (!res.ok) {
      if (res.status === 401) throw new BitbucketTokenExpiredError('listRepos');
      throw new Error(`Bitbucket listRepos failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      values: Array<{
        uuid: string;
        name: string;
        full_name: string;
        is_private: boolean;
        links: { html: { href: string } };
        mainbranch?: { name: string };
      }>;
    };

    return data.values.map((r) => ({
      id: r.uuid,
      name: r.name,
      fullName: r.full_name,
      isPrivate: r.is_private,
      htmlUrl: r.links.html.href,
      defaultBranch: r.mainbranch?.name ?? 'main',
    }));
  },

  async createRepo(
    accessToken: string,
    workspace: string,
    data: { name: string; description?: string; isPrivate?: boolean },
  ): Promise<{ id: string; name: string; fullName: string; htmlUrl: string; defaultBranch: string }> {
    const slug = data.name.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
    const res = await fetch(`${BITBUCKET_API}/repositories/${workspace}/${slug}`, {
      method: 'POST',
      headers: headers(accessToken),
      body: JSON.stringify({
        scm: 'git',
        name: data.name,
        description: data.description ?? '',
        is_private: data.isPrivate ?? true,
      }),
    });
    if (!res.ok) {
      if (res.status === 401) throw new BitbucketTokenExpiredError('createRepo');
      const body = await res.text();
      throw new Error(`Bitbucket createRepo failed: ${res.status} ${body}`);
    }
    const repo = (await res.json()) as {
      uuid: string;
      name: string;
      full_name: string;
      links: { html: { href: string } };
      mainbranch?: { name: string };
    };
    return {
      id: repo.uuid,
      name: repo.name,
      fullName: repo.full_name,
      htmlUrl: repo.links.html.href,
      defaultBranch: repo.mainbranch?.name ?? 'main',
    };
  },

  async getFileTree(
    accessToken: string,
    owner: string,
    repo: string,
    ref = 'HEAD',
  ): Promise<GitTreeEntry[]> {
    // Bitbucket uses /src endpoint with a path listing; for tree we recurse the root
    const res = await fetch(
      `${BITBUCKET_API}/repositories/${owner}/${repo}/src/${ref}/?pagelen=100`,
      { headers: headers(accessToken) },
    );

    if (!res.ok) {
      if (res.status === 401) throw new BitbucketTokenExpiredError('getFileTree');
      throw new Error(`Bitbucket getFileTree failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      values: Array<{
        path: string;
        type: string;
        size?: number;
      }>;
    };

    return data.values.map((e) => ({
      path: e.path,
      type: e.type === 'commit_file' ? 'blob' : 'tree',
      size: e.size,
    }));
  },

  async getFileContent(
    accessToken: string,
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<GitFileContent> {
    const revision = ref ?? 'HEAD';
    const res = await fetch(
      `${BITBUCKET_API}/repositories/${owner}/${repo}/src/${revision}/${path}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!res.ok) {
      if (res.status === 401) throw new BitbucketTokenExpiredError('getFileContent');
      throw new Error(`Bitbucket getFileContent failed: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    const name = path.split('/').pop() ?? path;

    return {
      name,
      path,
      size: text.length,
      content: Buffer.from(text).toString('base64'),
      encoding: 'base64',
      htmlUrl: `https://bitbucket.org/${owner}/${repo}/src/${revision}/${path}`,
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
    // Bitbucket issues API (must be enabled on the repo)
    const res = await fetch(
      `${BITBUCKET_API}/repositories/${owner}/${repo}/issues`,
      {
        method: 'POST',
        headers: headers(accessToken),
        body: JSON.stringify({
          title,
          content: { raw: body, markup: 'markdown' },
          kind: 'task',
          priority: 'major',
        }),
      },
    );

    if (!res.ok) {
      if (res.status === 401) throw new BitbucketTokenExpiredError('createIssue');
      throw new Error(`Bitbucket createIssue failed: ${res.status} ${res.statusText}`);
    }

    const issue = (await res.json()) as {
      id: number;
      title: string;
      links: { html: { href: string } };
      state: string;
    };

    return {
      id: issue.id,
      number: issue.id,
      title: issue.title,
      htmlUrl: issue.links.html.href,
      state: issue.state,
    };
  },

  async listIssues(
    accessToken: string,
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'all',
  ): Promise<GitIssue[]> {
    let query = '';
    if (state === 'open') query = '?q=state="new" OR state="open"';
    else if (state === 'closed') query = '?q=state="resolved" OR state="closed"';

    const res = await fetch(
      `${BITBUCKET_API}/repositories/${owner}/${repo}/issues${query}`,
      { headers: headers(accessToken) },
    );

    if (!res.ok) {
      if (res.status === 401) throw new BitbucketTokenExpiredError('listIssues');
      throw new Error(`Bitbucket listIssues failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      values: Array<{
        id: number;
        title: string;
        links: { html: { href: string } };
        state: string;
      }>;
    };

    return data.values.map((i) => ({
      id: i.id,
      number: i.id,
      title: i.title,
      htmlUrl: i.links.html.href,
      state: i.state,
    }));
  },

  async createWebhook(
    token: string,
    owner: string,
    repo: string,
    webhookUrl: string,
    _secret: string,
  ): Promise<GitWebhook> {
    // Bitbucket webhooks don't support a shared secret for payload verification
    // in the same way as GitHub/GitLab. We use a URL-based token approach instead.
    const res = await fetch(
      `${BITBUCKET_API}/repositories/${owner}/${repo}/hooks`,
      {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({
          description: 'Nyx push notifications',
          url: webhookUrl,
          active: true,
          events: ['repo:push', 'issue:created', 'issue:updated'],
        }),
      },
    );

    if (!res.ok) {
      if (res.status === 401) throw new BitbucketTokenExpiredError('createWebhook');
      throw new Error(`Bitbucket createWebhook failed: ${res.status} ${res.statusText}`);
    }

    const hook = (await res.json()) as { uuid: string };
    return { id: hook.uuid };
  },

  async deleteWebhook(
    token: string,
    owner: string,
    repo: string,
    hookId: number | string,
  ): Promise<void> {
    const res = await fetch(
      `${BITBUCKET_API}/repositories/${owner}/${repo}/hooks/${hookId}`,
      { method: 'DELETE', headers: headers(token) },
    );

    if (!res.ok && res.status !== 404) {
      if (res.status === 401) throw new BitbucketTokenExpiredError('deleteWebhook');
      throw new Error(`Bitbucket deleteWebhook failed: ${res.status} ${res.statusText}`);
    }
  },

  async exchangeCodeForToken(
    clientId: string,
    clientSecret: string,
    code: string,
    _redirectUri?: string,
  ): Promise<OAuthTokenResult> {
    // Bitbucket uses Basic auth with client_id:client_secret for token exchange
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const res = await fetch(`${BITBUCKET_AUTH}/access_token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
      }).toString(),
    });

    if (!res.ok) {
      throw new Error(`Bitbucket token exchange failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      scopes?: string;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };

    if (data.error) {
      throw new Error(`Bitbucket OAuth error: ${data.error_description || data.error}`);
    }
    if (!data.access_token) {
      throw new Error('Bitbucket token exchange returned no access_token');
    }

    return {
      access_token: data.access_token,
      token_type: data.token_type ?? 'bearer',
      scope: data.scopes ?? '',
      refresh_token: data.refresh_token,
    };
  },

  async getAuthenticatedUser(accessToken: string): Promise<GitUser> {
    const res = await fetch(`${BITBUCKET_API}/user`, {
      headers: headers(accessToken),
    });

    if (!res.ok) {
      if (res.status === 401) throw new BitbucketTokenExpiredError('getAuthenticatedUser');
      throw new Error(`Bitbucket getUser failed: ${res.status} ${res.statusText}`);
    }

    const user = (await res.json()) as {
      username: string;
      uuid: string;
      display_name: string;
      links: { avatar: { href: string } };
    };

    return {
      login: user.username,
      id: user.uuid,
      avatarUrl: user.links.avatar.href,
      name: user.display_name,
    };
  },
};
