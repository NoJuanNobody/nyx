import { randomBytes, createHash } from 'node:crypto';
import { eq, and, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { atlassianConnections, pkceChallenges } from '../db/schema.js';
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

const PKCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
 * Convert markdown-style text to Atlassian Document Format (ADF).
 * Supports: headings (h1-h6), bullet/numbered lists, code blocks,
 * inline code, bold, italic, links, and plain paragraphs.
 */
export function textToAdf(text: string, appendUrl?: string): object {
  const content: object[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code block
    const codeBlockMatch = line.match(/^```(\w*)/);
    if (codeBlockMatch) {
      const language = codeBlockMatch[1] || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const attrs: Record<string, unknown> = {};
      if (language) attrs.language = language;
      content.push({
        type: 'codeBlock',
        attrs,
        content: [{ type: 'text', text: codeLines.join('\n') }],
      });
      continue;
    }

    // Heading (# through ######)
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      content.push({
        type: 'heading',
        attrs: { level },
        content: parseInlineMarks(headingMatch[2]),
      });
      i++;
      continue;
    }

    // Bullet list (-, *, +)
    if (/^[\-\*\+]\s+/.test(line)) {
      const items: object[] = [];
      while (i < lines.length && /^[\-\*\+]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^[\-\*\+]\s+/, '');
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInlineMarks(itemText) }],
        });
        i++;
      }
      content.push({ type: 'bulletList', content: items });
      continue;
    }

    // Numbered list (1. 2. etc.)
    if (/^\d+\.\s+/.test(line)) {
      const items: object[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\d+\.\s+/, '');
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: parseInlineMarks(itemText) }],
        });
        i++;
      }
      content.push({ type: 'orderedList', content: items });
      continue;
    }

    // Regular paragraph
    content.push({
      type: 'paragraph',
      content: parseInlineMarks(line),
    });
    i++;
  }

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
 * Parse inline markdown marks: **bold**, *italic*, `code`, [text](url)
 */
export function parseInlineMarks(text: string): object[] {
  const nodes: object[] = [];
  // Regex matches: **bold**, *italic*, `code`, [text](url), or plain text
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Add plain text before this match
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }

    if (match[2]) {
      // Bold
      nodes.push({ type: 'text', text: match[2], marks: [{ type: 'strong' }] });
    } else if (match[4]) {
      // Italic
      nodes.push({ type: 'text', text: match[4], marks: [{ type: 'em' }] });
    } else if (match[6]) {
      // Inline code
      nodes.push({ type: 'text', text: match[6], marks: [{ type: 'code' }] });
    } else if (match[8] && match[9]) {
      // Link
      nodes.push({
        type: 'text',
        text: match[8],
        marks: [{ type: 'link', attrs: { href: match[9] } }],
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining plain text
  if (lastIndex < text.length) {
    nodes.push({ type: 'text', text: text.slice(lastIndex) });
  }

  // If no matches found, return the whole text as a single node
  if (nodes.length === 0) {
    nodes.push({ type: 'text', text });
  }

  return nodes;
}

/**
 * Convert ADF content back to plain text (simplified).
 */
export function adfToText(adf: { content?: Array<{ type?: string; content?: Array<{ text?: string }>; attrs?: Record<string, unknown> }> }): string {
  if (!adf?.content) return '';
  return adf.content
    .map((block) => {
      if (block.type === 'heading') {
        const level = (block.attrs?.level as number) ?? 1;
        const text = block.content?.map((inline) => inline.text ?? '').join('') ?? '';
        return '#'.repeat(level) + ' ' + text;
      }
      if (block.type === 'codeBlock') {
        const lang = (block.attrs?.language as string) ?? '';
        const text = block.content?.map((inline) => inline.text ?? '').join('') ?? '';
        return '```' + lang + '\n' + text + '\n```';
      }
      if (block.type === 'bulletList' || block.type === 'orderedList') {
        const items = block.content as Array<{ content?: Array<{ content?: Array<{ text?: string }> }> }> | undefined;
        if (!items) return '';
        return items.map((item, idx) => {
          const itemText = item.content?.[0]?.content?.map((inline) => inline.text ?? '').join('') ?? '';
          return block.type === 'orderedList' ? `${idx + 1}. ${itemText}` : `- ${itemText}`;
        }).join('\n');
      }
      return block.content?.map((inline) => inline.text ?? '').join('') ?? '';
    })
    .join('\n\n');
}

// ── Service ──────────────────────────────────────────────────────

export const atlassianService = {
  // ── OAuth Flow ─────────────────────────────────────────────

  /**
   * Build the Atlassian OAuth authorization URL with PKCE.
   * Stores PKCE data in the database for multi-instance safety.
   */
  async buildAuthUrl(redirectUri: string, userId: string, teamId: string): Promise<string> {
    if (!config.ATLASSIAN_CLIENT_ID) {
      throw new Error('ATLASSIAN_CLIENT_ID is not configured');
    }

    const state = generateStateToken();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Store PKCE data in DB with TTL
    await db.insert(pkceChallenges).values({
      state,
      codeVerifier,
      userId,
      teamId,
      expiresAt: new Date(Date.now() + PKCE_TTL_MS),
    });

    // Clean up expired challenges opportunistically
    await db.delete(pkceChallenges).where(lt(pkceChallenges.expiresAt, new Date())).catch(() => {});

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
   * Reads from the database and deletes after retrieval (one-time use).
   */
  async getPkceData(state: string): Promise<{ codeVerifier: string; userId: string; teamId: string } | null> {
    const [row] = await db
      .select()
      .from(pkceChallenges)
      .where(eq(pkceChallenges.state, state));

    if (!row) return null;

    // Delete the challenge (one-time use)
    await db.delete(pkceChallenges).where(eq(pkceChallenges.state, state));

    // Check expiration
    if (new Date() > row.expiresAt) return null;

    return {
      codeVerifier: row.codeVerifier,
      userId: row.userId,
      teamId: row.teamId,
    };
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
   * Also cleans up any registered Jira webhooks.
   */
  async disconnect(userId: string): Promise<boolean> {
    const [connection] = await db
      .select()
      .from(atlassianConnections)
      .where(eq(atlassianConnections.userId, userId));

    if (!connection) return false;

    // Best-effort revoke the access token and delete webhook
    try {
      const accessToken = decrypt(connection.accessToken);

      // Delete registered Jira webhook if it exists
      if (connection.webhookId) {
        await this.deleteJiraWebhook(accessToken, connection.cloudId, connection.webhookId).catch(() => {});
      }

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

  // ── Jira Webhook Management ────────────────────────────────

  /**
   * Register a Jira webhook for status change events.
   * Stores the webhook ID on the connection for cleanup on disconnect.
   */
  async registerJiraWebhook(
    accessToken: string,
    cloudId: string,
    connectionId: string,
    webhookUrl: string,
  ): Promise<string | null> {
    try {
      const res = await fetch(
        `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/webhook`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: webhookUrl,
            webhooks: [
              {
                events: ['jira:issue_updated', 'jira:issue_deleted'],
                jqlFilter: '',
              },
            ],
          }),
        },
      );

      if (!res.ok) {
        return null;
      }

      const data = (await res.json()) as { webhookRegistrationResult?: Array<{ createdWebhookId?: number }> };
      const webhookId = data.webhookRegistrationResult?.[0]?.createdWebhookId?.toString();

      if (webhookId) {
        await db
          .update(atlassianConnections)
          .set({ webhookId, updatedAt: new Date() })
          .where(eq(atlassianConnections.id, connectionId));
      }

      return webhookId ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Delete a registered Jira webhook.
   */
  async deleteJiraWebhook(
    accessToken: string,
    cloudId: string,
    webhookId: string,
  ): Promise<void> {
    await fetch(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/webhook`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ webhookIds: [parseInt(webhookId, 10)] }),
      },
    );
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

// ── Webhook Signature Validation ────────────────────────────────

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Validate an incoming Jira webhook request using HMAC-SHA256 signature.
 * Returns true if the signature is valid, false otherwise.
 */
export function validateJiraWebhookSignature(
  rawBody: string | Buffer,
  signature: string | undefined,
): boolean {
  const secret = config.JIRA_WEBHOOK_SECRET;
  if (!secret) {
    // If no secret is configured, skip validation (dev mode)
    return true;
  }

  if (!signature) {
    return false;
  }

  const expected = createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'))
    .digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Custom Errors ────────────────────────────────────────────────

export class AtlassianTokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AtlassianTokenExpiredError';
  }
}
