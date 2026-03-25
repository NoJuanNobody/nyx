// Git provider abstraction — common interface for GitHub, GitLab, and Bitbucket

export interface GitRepo {
  id: string | number;
  name: string;
  fullName: string;
  isPrivate: boolean;
  htmlUrl: string;
  defaultBranch: string;
}

export interface GitTreeEntry {
  path: string;
  type: string;
  size?: number;
}

export interface GitFileContent {
  name: string;
  path: string;
  size: number;
  content: string;
  encoding: string;
  htmlUrl: string;
}

export interface GitIssue {
  id: string | number;
  number?: number;
  iid?: number;
  title: string;
  htmlUrl: string;
  state: string;
}

export interface GitWebhook {
  id: number | string;
}

export interface GitUser {
  login: string;
  id: number | string;
  avatarUrl: string;
  name: string | null;
}

export interface OAuthTokenResult {
  access_token: string;
  token_type: string;
  scope: string;
  refresh_token?: string;
}

export type GitProviderType = 'github' | 'gitlab' | 'bitbucket';

/**
 * Common interface for git hosting providers.
 * Each provider (GitHub, GitLab, Bitbucket) implements this interface.
 */
export interface GitProvider {
  readonly providerType: GitProviderType;

  /** List repositories accessible to the authenticated user. */
  listRepos(accessToken: string): Promise<GitRepo[]>;

  /** Get the file tree for a repository. */
  getFileTree(accessToken: string, owner: string, repo: string, ref?: string): Promise<GitTreeEntry[]>;

  /** Get the content of a single file. */
  getFileContent(accessToken: string, owner: string, repo: string, path: string, ref?: string): Promise<GitFileContent>;

  /** Create an issue in a repository. */
  createIssue(
    accessToken: string,
    owner: string,
    repo: string,
    title: string,
    body: string,
    labels?: string[],
  ): Promise<GitIssue>;

  /** List issues in a repository. */
  listIssues(accessToken: string, owner: string, repo: string, state?: 'open' | 'closed' | 'all'): Promise<GitIssue[]>;

  /** Register a webhook on a repository. */
  createWebhook(
    token: string,
    owner: string,
    repo: string,
    webhookUrl: string,
    secret: string,
  ): Promise<GitWebhook>;

  /** Delete a webhook from a repository. */
  deleteWebhook(token: string, owner: string, repo: string, hookId: number | string): Promise<void>;

  /** Exchange an OAuth authorization code for an access token. */
  exchangeCodeForToken(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri?: string,
  ): Promise<OAuthTokenResult>;

  /** Get the currently authenticated user. */
  getAuthenticatedUser(accessToken: string): Promise<GitUser>;
}
