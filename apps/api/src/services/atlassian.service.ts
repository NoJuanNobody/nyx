import { randomBytes, createHash } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { atlassianConnections } from '../db/schema.js';
import { config } from '../lib/config.js';
import { encrypt, decrypt } from '../lib/encryption.js';
import type {
  CreateJiraIssuePayload,
  JiraProject,
  JiraIssue,
  ConfluenceSpace,
  ConfluencePage,
  NyxTicketStatus,
} from '@nyx/shared';
import { JIRA_STATUS_TO_NYX } from '@nyx/shared';

// ── PKCE Utilities ───────────────────────────────────────────────

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_REVOKE_URL = 'https://auth.atlassian.com/oauth/revoke';
const ATLASSIAN_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

const SCOPES = [
  'read:jira-work',
  'write:jira-work',
  'read:confluence-content.all',
  'write:confluence-content.all',
  'offline_access',
];

// In-memory PKCE state store (keyed by state token)
// In production, this should use Redis or a DB table with TTL.
const pkceStore = new Map<string, { codeVerifier: string; userId: string; teamId: string }>();

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function generateStateToken(): string {
  return randomBytes(32).toString('hex');
}

// ── Token Refresh Buffer ─────────────────────────────────────────

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

function isTokenExpiringSoon(expiresAt: Date): boolean {
  return expiresAt.getTime() - Date.now() < TOKEN_REFRESH_BUFFER_MS;
}

// ── ADF Conversion ───────────────────────────────────────────────

/**
 * Convert plain/markdown text to a minimal Atlassian Document Format (ADF) structure.
 */
export function textToAdf(text: string, appendUrl?: string): object {
  const content: object[] = text.split('\n\n').map((paragraph) => ({
    type: 'paragraph',
    content: [{ type: 'text', text: paragraph }],
  }));

  if (appendUrl) {
    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Source: ' },
        {
          type: 'text',
          text: appendUrl,
          marks: [{ type: 'link', attrs: { href: appendUrl } }],
        },
      ],
    });
  }

  return {
    type: 'doc',
    version: 1,
    content,
  };
}

/**
 * Convert ADF content back to plain text (simplified).
 */
export function adfToText(adf: { content?: Array<{ content?: Array<{ text?: string }> }> }): string {
  if (!adf?.content) return '';
  return adf.content
    .map((block) =>
      block.content?.map((inline) => inline.text ?? '').join('') ?? '',
    )
    .join('\n\n');
}

// ── Service ──────────────────────────────────────────────────────

export const atlassianService = {
  // ── OAuth Flow ─────────────────────────────────────────────

  /**
   * Build the Atlassian OAuth authorization URL with PKCE.
   */
  buildAuthUrl(redirectUri: string, userId: string, teamId: string): string {
    if (!config.ATLASSIAN_CLIENT_ID) {
      throw new Error('ATLASSIAN_CLIENT_ID is not configured');
    }

    const state = generateStateToken();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Store PKCE data keyed by state
    pkceStore.set(state, { codeVerifier, userId, teamId });

    // Auto-expire after 10 minutes
    setTimeout(() => pkceStore.delete(state), 10 * 60 * 1000);

    const params = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: config.ATLASSIAN_CLIENT_ID,
      scope: SCOPES.join(' '),
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      prompt: 'consent',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return `${ATLASSIAN_AUTH_URL}?${params.toString()}`;
  },

  /**
   * Retrieve and validate the stored PKCE data for a given state token.
   */
  getPkceData(state: string): { codeVerifier: string; userId: string; teamId: string } | null {
    const data = pkceStore.get(state);
    if (!data) return null;
    pkceStore.delete(state);
    return data;
  },

  /**
   * Exchange an authorization code for access and refresh tokens.
   */
  async exchangeCodeForTokens(
    code: string,
    redirectUri: string,
    codeVerifier: string,
  ): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string }> {
    const res = await fetch(ATLASSIAN_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: config.ATLASSIAN_CLIENT_ID,
        client_secret: config.ATLASSIAN_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token exchange failed: ${res.status} ${body}`);
    }

    return res.json() as Promise<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    }>;
  },

  /**
   * Fetch the user's accessible Atlassian Cloud resources.
   */
  async getAccessibleResources(
    accessToken: string,
  ): Promise<Array<{ id: string; url: string; name: string }>> {
    const res = await fetch(ATLASSIAN_RESOURCES_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch accessible resources: ${res.status}`);
    }

    return res.json() as Promise<Array<{ id: string; url: string; name: string }>>;
  },

  /**
   * Refresh an expired access token using the refresh token.
   */
  async refreshAccessToken(
    refreshToken: string,
  ): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    const res = await fetch(ATLASSIAN_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: config.ATLASSIAN_CLIENT_ID,
        client_secret: config.ATLASSIAN_CLIENT_SECRET,
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      const status = res.status;
      if (status === 401 || status === 400) {
        throw new AtlassianTokenExpiredError('Refresh token is invalid or expired');
      }
      throw new Error(`Token refresh failed: ${status}`);
    }

    return res.json() as Promise<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
    }>;
  },

  /**
   * Revoke an access token.
   */
  async revokeToken(accessToken: string): Promise<void> {
    await fetch(ATLASSIAN_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.ATLASSIAN_CLIENT_ID,
        token: accessToken,
      }),
    });
    // Revocation is best-effort; ignore errors
  },

  // ── Connection Management ──────────────────────────────────

  /**
   * Store a new Atlassian connection with encrypted tokens.
   */
  async storeConnection(params: {
    userId: string;
    teamId: string;
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    cloudId: string;
    siteUrl: string;
    scopes: string[];
  }) {
    const tokenExpiresAt = new Date(Date.now() + params.expiresIn * 1000);

    const [connection] = await db
      .insert(atlassianConnections)
      .values({
        userId: params.userId,
        organizationId: params.teamId,
        accessToken: encrypt(params.accessToken),
        refreshToken: encrypt(params.refreshToken),
        tokenExpiresAt,
        cloudId: params.cloudId,
        siteUrl: params.siteUrl,
        scopes: params.scopes,
        status: 'connected',
      })
      .returning();

    return connection;
  },

  /**
   * Get a valid access token for a user, refreshing if needed.
   */
  async getValidToken(userId: string): Promise<{ accessToken: string; cloudId: string } | null> {
    const [connection] = await db
      .select()
      .from(atlassianConnections)
      .where(and(eq(atlassianConnections.userId, userId), eq(atlassianConnections.status, 'connected')));

    if (!connection) return null;

    let accessToken = decrypt(connection.accessToken);

    if (isTokenExpiringSoon(connection.tokenExpiresAt)) {
      try {
        const refreshToken = decrypt(connection.refreshToken);
        const newTokens = await this.refreshAccessToken(refreshToken);

        await db
          .update(atlassianConnections)
          .set({
            accessToken: encrypt(newTokens.access_token),
            refreshToken: encrypt(newTokens.refresh_token),
            tokenExpiresAt: new Date(Date.now() + newTokens.expires_in * 1000),
            updatedAt: new Date(),
          })
          .where(eq(atlassianConnections.id, connection.id));

        accessToken = newTokens.access_token;
      } catch (err) {
        if (err instanceof AtlassianTokenExpiredError) {
          await db
            .update(atlassianConnections)
            .set({ status: 'token_expired', updatedAt: new Date() })
            .where(eq(atlassianConnections.id, connection.id));
          return null;
        }
        throw err;
      }
    }

    return { accessToken, cloudId: connection.cloudId };
  },

  /**
   * Get the connection status for a user.
   */
  async getConnectionStatus(userId: string) {
    const [connection] = await db
      .select()
      .from(atlassianConnections)
      .where(eq(atlassianConnections.userId, userId));

    if (!connection) {
      return { status: 'disconnected' as const, connection: null };
    }

    return {
      status: connection.status,
      connection: {
        id: connection.id,
        cloudId: connection.cloudId,
        siteUrl: connection.siteUrl,
        scopes: connection.scopes,
        status: connection.status,
        preferences: connection.preferences,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      },
    };
  },

  /**
   * Disconnect and revoke an Atlassian connection.
   */
  async disconnect(userId: string): Promise<boolean> {
    const [connection] = await db
      .select()
      .from(atlassianConnections)
      .where(eq(atlassianConnections.userId, userId));

    if (!connection) return false;

    // Best-effort revoke the access token
    try {
      const accessToken = decrypt(connection.accessToken);
      await this.revokeToken(accessToken);
    } catch {
      // Revocation is best-effort
    }

    await db
      .delete(atlassianConnections)
      .where(eq(atlassianConnections.id, connection.id));

    return true;
  },

  // ── Jira Operations ────────────────────────────────────────

  /**
   * List Jira projects accessible to the user.
   */
  async listJiraProjects(accessToken: string, cloudId: string): Promise<JiraProject[]> {
    const res = await fetch(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/project/search`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
    );

    if (!res.ok) {
      throw new Error(`Jira listProjects failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { values: JiraProject[] };
    return data.values;
  },

  /**
   * Create a Jira issue from a Nyx spec section.
   */
  async createJiraIssue(
    accessToken: string,
    cloudId: string,
    payload: CreateJiraIssuePayload,
  ): Promise<JiraIssue> {
    const description = textToAdf(payload.description, payload.specUrl);

    const fields: Record<string, unknown> = {
      project: { key: payload.projectKey },
      summary: payload.summary.slice(0, 255),
      description,
      issuetype: { name: payload.issueType ?? 'Task' },
    };

    if (payload.labels?.length) {
      fields.labels = payload.labels;
    }
    if (payload.priority) {
      fields.priority = { name: payload.priority };
    }
    if (payload.assigneeAccountId) {
      fields.assignee = { accountId: payload.assigneeAccountId };
    }

    const res = await fetch(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jira createIssue failed: ${res.status} ${body}`);
    }

    return (await res.json()) as JiraIssue;
  },

  /**
   * Map a Jira status category to a Nyx ticket status.
   */
  mapJiraStatusToNyx(statusCategory: string): NyxTicketStatus {
    return JIRA_STATUS_TO_NYX[statusCategory] ?? 'pending';
  },

  // ── Confluence Operations ──────────────────────────────────

  /**
   * List Confluence spaces.
   */
  async listConfluenceSpaces(accessToken: string, cloudId: string): Promise<ConfluenceSpace[]> {
    const res = await fetch(
      `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2/spaces`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
    );

    if (!res.ok) {
      throw new Error(`Confluence listSpaces failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { results: ConfluenceSpace[] };
    return data.results;
  },

  /**
   * Export a Nyx document to a Confluence page.
   */
  async exportToConfluence(
    accessToken: string,
    cloudId: string,
    params: { spaceId: string; title: string; content: string; parentPageId?: string; existingPageId?: string },
  ): Promise<ConfluencePage> {
    const adfContent = textToAdf(params.content);

    if (params.existingPageId) {
      // Update existing page — need to get current version first
      const getRes = await fetch(
        `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2/pages/${params.existingPageId}`,
        { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
      );

      if (!getRes.ok) {
        throw new Error(`Confluence getPage failed: ${getRes.status}`);
      }

      const existingPage = (await getRes.json()) as { version: { number: number } };

      const res = await fetch(
        `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2/pages/${params.existingPageId}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            id: params.existingPageId,
            status: 'current',
            title: params.title,
            body: { representation: 'atlas_doc_format', value: JSON.stringify(adfContent) },
            version: { number: existingPage.version.number + 1 },
          }),
        },
      );

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Confluence updatePage failed: ${res.status} ${body}`);
      }

      return (await res.json()) as ConfluencePage;
    }

    // Create new page
    const body: Record<string, unknown> = {
      spaceId: params.spaceId,
      status: 'current',
      title: params.title,
      body: { representation: 'atlas_doc_format', value: JSON.stringify(adfContent) },
    };

    if (params.parentPageId) {
      body.parentId = params.parentPageId;
    }

    const res = await fetch(
      `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2/pages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const responseBody = await res.text();
      throw new Error(`Confluence createPage failed: ${res.status} ${responseBody}`);
    }

    return (await res.json()) as ConfluencePage;
  },

  /**
   * Import a Confluence page into Nyx.
   */
  async importFromConfluence(
    accessToken: string,
    cloudId: string,
    pageId: string,
  ): Promise<{ title: string; content: string; pageId: string; spaceId: string }> {
    const res = await fetch(
      `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2/pages/${pageId}?body-format=atlas_doc_format`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } },
    );

    if (!res.ok) {
      throw new Error(`Confluence getPage failed: ${res.status}`);
    }

    const page = (await res.json()) as {
      id: string;
      title: string;
      spaceId: string;
      body: { atlas_doc_format: { value: string } };
    };

    const adf = JSON.parse(page.body.atlas_doc_format.value);
    const content = adfToText(adf);

    return {
      title: page.title,
      content,
      pageId: page.id,
      spaceId: page.spaceId,
    };
  },
};

// ── Custom Errors ────────────────────────────────────────────────

export class AtlassianTokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AtlassianTokenExpiredError';
  }
}
