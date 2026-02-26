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

// ── Service ───────────────────────────────────────────

export const githubService = {
  async listRepos(accessToken: string): Promise<GitHubRepo[]> {
    const res = await fetch(`${GITHUB_API}/user/repos?per_page=100&sort=updated`, {
      headers: headers(accessToken),
    });

    if (!res.ok) {
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
