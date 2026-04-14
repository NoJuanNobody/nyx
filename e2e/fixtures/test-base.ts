import { test as base, expect, type Page } from '@playwright/test';
import { SEED } from '../seed-ids';
import {
  mockQualityResponse,
  mockEditResponse,
  mockGenerateResponse,
  mockDriftResponse,
  mockGitHubRepos,
  mockGitHubIssue,
  mockProposalResponse,
} from './api-mocks';

// ── Canned data matching apps/api/src/db/seed.ts ────────────────────

const SEEDED_USER = {
  id: SEED.DEV_USER_ID,
  email: SEED.DEV_EMAIL,
  name: 'Dev User',
  role: 'owner',
  avatarUrl: null,
  clerkId: null,
};

const SEEDED_TEAMS = [
  { id: SEED.DEFAULT_TEAM_ID, name: 'Default Team', slug: 'default', role: 'owner' },
  { id: SEED.SECOND_TEAM_ID, name: 'Second Team', slug: 'second-team', role: 'owner' },
];

const SEEDED_DOCUMENTS = [
  {
    id: SEED.DOC_API_SPEC_ID,
    title: 'API Specification',
    content: `# API Specification\n\n## Authentication\n\nAll API endpoints require authentication via Bearer token (JWT or API key).\n\n### Endpoints\n\n| Method | Path | Description |\n|--------|------|-------------|\n| GET | /api/documents | List all documents |\n| POST | /api/documents | Create a document |\n| GET | /api/documents/:id | Get document by ID |\n| PUT | /api/documents/:id | Update document |\n| DELETE | /api/documents/:id | Archive document |\n\n### Request Headers\n\n\`\`\`\nAuthorization: Bearer <token>\nContent-Type: application/json\n\`\`\`\n\n## Rate Limiting\n\nAPI requests are rate-limited to **100 requests per minute** per API key.\n\n### Error Responses\n\n\`\`\`json\n{\n  "error": "Rate limit exceeded",\n  "retryAfter": 60\n}\n\`\`\`\n`,
    path: '/api',
    status: 'draft',
    teamId: SEED.DEFAULT_TEAM_ID,
    createdById: SEED.DEV_USER_ID,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
  {
    id: SEED.DOC_ARCHITECTURE_ID,
    title: 'Architecture Overview',
    content: '# Architecture Overview\n\n## System Design\n\nNyx uses a monorepo architecture.',
    path: '/',
    status: 'published',
    teamId: SEED.DEFAULT_TEAM_ID,
    createdById: SEED.DEV_USER_ID,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
  {
    id: SEED.DOC_QUICKSTART_ID,
    title: 'Quick Start',
    content: '# Quick Start\n\nGet up and running with Nyx in 5 minutes.',
    path: '/',
    status: 'draft',
    teamId: SEED.DEFAULT_TEAM_ID,
    createdById: SEED.DEV_USER_ID,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
];

const SEEDED_ARCHIVED_DOCS = [
  {
    id: SEED.DOC_DEPRECATED_ID,
    title: 'Deprecated Guide',
    content: '# Deprecated Guide\n\nThis document is no longer maintained.',
    path: '/api',
    status: 'archived',
    teamId: SEED.DEFAULT_TEAM_ID,
    createdById: SEED.DEV_USER_ID,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
];

const SEEDED_SECOND_TEAM_DOCS = [
  {
    id: SEED.DOC_SECOND_TEAM_ID,
    title: 'Second Team Doc',
    content: '# Second Team\n\nDocumentation for the second team.',
    path: '/',
    status: 'draft',
    teamId: SEED.SECOND_TEAM_ID,
    createdById: SEED.DEV_USER_ID,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
];

const SEEDED_VERSIONS = [
  {
    id: SEED.VER_API_V1_ID,
    documentId: SEED.DOC_API_SPEC_ID,
    version: 1,
    content: '# API Specification\n\n## Authentication\n\nAll API endpoints require authentication via Bearer token.\n\n### Endpoints\n\n| Method | Path | Description |\n|--------|------|-------------|\n| GET | /api/documents | List all documents |\n| POST | /api/documents | Create a document |',
    message: 'Initial draft',
    createdById: SEED.DEV_USER_ID,
    createdAt: '2025-01-01T00:00:00Z',
  },
  {
    id: SEED.VER_API_V2_ID,
    documentId: SEED.DOC_API_SPEC_ID,
    version: 2,
    content: SEEDED_DOCUMENTS[0].content,
    message: 'Added endpoints',
    createdById: SEED.DEV_USER_ID,
    createdAt: '2025-01-02T00:00:00Z',
  },
];

export const SEEDED_INSIGHT = {
  title: 'Implement auth endpoints',
  summary: [
    'Added JWT middleware to all protected routes',
    'Created /api/auth/login and /api/auth/logout endpoints',
    'Updated tests to cover auth flows',
  ],
  filesChanged: [
    'apps/api/src/middleware/auth.ts',
    'apps/api/src/routes/auth.ts',
    'apps/api/src/__tests__/auth.test.ts',
  ],
  commentId: 1234567890,
  commentUrl: 'https://github.com/nyx/app/issues/101#issuecomment-1234567890',
  commentedAt: '2025-01-02T10:00:00Z',
  fetchedAt: '2025-01-02T10:05:00Z',
};

const SEEDED_TICKETS = [
  {
    id: SEED.TKT_GH_OPEN_ID,
    documentId: SEED.DOC_API_SPEC_ID,
    provider: 'github',
    externalId: '101',
    externalUrl: 'https://github.com/nyx/app/issues/101',
    title: 'Implement auth endpoints',
    status: 'open',
    claudeInsights: SEEDED_INSIGHT,
    createdById: SEED.DEV_USER_ID,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    documentTitle: 'API Specification',
  },
  {
    id: SEED.TKT_GH_CLOSED_ID,
    documentId: SEED.DOC_API_SPEC_ID,
    provider: 'github',
    externalId: '102',
    externalUrl: 'https://github.com/nyx/app/issues/102',
    title: 'Fix rate limiting',
    status: 'closed',
    claudeInsights: null,
    createdById: SEED.DEV_USER_ID,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    documentTitle: 'API Specification',
  },
  {
    id: SEED.TKT_JIRA_OPEN_ID,
    documentId: SEED.DOC_ARCHITECTURE_ID,
    provider: 'jira',
    externalId: 'SD-1',
    externalUrl: 'https://nyx.atlassian.net/browse/SD-1',
    title: 'Review architecture',
    status: 'open',
    claudeInsights: null,
    createdById: SEED.DEV_USER_ID,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    documentTitle: 'Architecture Overview',
  },
  {
    id: SEED.TKT_JIRA_INPROG_ID,
    documentId: SEED.DOC_ARCHITECTURE_ID,
    provider: 'jira',
    externalId: 'SD-2',
    externalUrl: 'https://nyx.atlassian.net/browse/SD-2',
    title: 'Update deployment docs',
    status: 'in_progress',
    claudeInsights: null,
    createdById: SEED.DEV_USER_ID,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    documentTitle: 'Architecture Overview',
  },
];

const SEEDED_MEMBERS = [
  { id: 'tm-1', userId: SEED.DEV_USER_ID, role: 'owner', joinedAt: '2025-01-01T00:00:00Z', userName: 'Dev User', userEmail: SEED.DEV_EMAIL },
  { id: 'tm-2', userId: SEED.ALICE_ID, role: 'admin', joinedAt: '2025-01-01T00:00:00Z', userName: 'Alice Admin', userEmail: SEED.ALICE_EMAIL },
  { id: 'tm-3', userId: SEED.BOB_ID, role: 'viewer', joinedAt: '2025-01-01T00:00:00Z', userName: 'Bob Viewer', userEmail: SEED.BOB_EMAIL },
];

const SEEDED_INVITATIONS = [
  {
    id: '00000000-0000-0000-0000-000000000700',
    teamId: SEED.DEFAULT_TEAM_ID,
    email: SEED.PENDING_INVITE_EMAIL,
    role: 'developer',
    invitedById: SEED.DEV_USER_ID,
    status: 'pending',
    createdAt: '2025-01-01T00:00:00Z',
    expiresAt: '2030-01-08T00:00:00Z',
  },
];

const SEEDED_INTEGRATIONS = [
  {
    id: SEED.INT_GITHUB_ID,
    teamId: SEED.DEFAULT_TEAM_ID,
    type: 'github',
    config: {
      accessToken: 'ghp_test_token_for_e2e_seeding',
      selectedRepos: [{ owner: 'nyx', name: 'app', fullName: 'nyx/app' }],
      webhookSecret: 'wh-secret-123',
    },
    createdAt: '2025-01-01T00:00:00Z',
  },
  {
    id: SEED.INT_JIRA_ID,
    teamId: SEED.DEFAULT_TEAM_ID,
    type: 'jira',
    config: {
      baseUrl: 'https://nyx.atlassian.net',
      email: 'admin@nyx.io',
      apiToken: 'jira-token-for-e2e',
      projectKey: 'SD',
    },
    createdAt: '2025-01-01T00:00:00Z',
  },
];

const SEEDED_API_KEYS = [
  {
    id: '00000000-0000-0000-0000-000000000800',
    name: 'CI/CD Key',
    keyPrefix: 'sd_test_cicd',
    scopes: ['read', 'write'],
    lastUsedAt: null,
    expiresAt: null,
    revoked: false,
    createdAt: '2025-01-01T00:00:00Z',
  },
];

const SEEDED_TIMELINE_EVENTS = [
  {
    id: '00000000-0000-0000-0000-000000000600',
    documentId: SEED.DOC_API_SPEC_ID,
    type: 'document_updated',
    payload: { fields: ['content'] },
    actorId: SEED.DEV_USER_ID,
    createdAt: '2025-01-01T00:00:00Z',
  },
  {
    id: '00000000-0000-0000-0000-000000000601',
    documentId: SEED.DOC_API_SPEC_ID,
    type: 'version_created',
    payload: { version: 1, message: 'Initial draft' },
    actorId: SEED.DEV_USER_ID,
    createdAt: '2025-01-01T00:00:00Z',
  },
];

const SEEDED_AUDIT_EVENTS = [
  {
    id: '00000000-0000-0000-0000-000000000500',
    teamId: SEED.DEFAULT_TEAM_ID,
    eventType: 'doc_edit',
    actorId: SEED.DEV_USER_ID,
    actorName: 'Dev User',
    documentId: SEED.DOC_API_SPEC_ID,
    snapshotId: null,
    ticketId: null,
    commitSha: null,
    parentEventId: null,
    metadata: { fields: ['content'] },
    createdAt: '2025-01-01T00:00:00Z',
  },
  {
    id: '00000000-0000-0000-0000-000000000501',
    teamId: SEED.DEFAULT_TEAM_ID,
    eventType: 'ticket_created',
    actorId: SEED.DEV_USER_ID,
    actorName: 'Dev User',
    documentId: SEED.DOC_API_SPEC_ID,
    snapshotId: null,
    ticketId: SEED.TKT_GH_OPEN_ID,
    commitSha: null,
    parentEventId: null,
    metadata: { provider: 'github', title: 'Implement auth endpoints' },
    createdAt: '2025-01-01T01:00:00Z',
  },
  {
    id: '00000000-0000-0000-0000-000000000502',
    teamId: SEED.DEFAULT_TEAM_ID,
    eventType: 'doc_edit',
    actorId: SEED.DEV_USER_ID,
    actorName: 'Dev User',
    documentId: SEED.DOC_API_SPEC_ID,
    snapshotId: null,
    ticketId: null,
    commitSha: null,
    parentEventId: '00000000-0000-0000-0000-000000000501',
    metadata: { fields: ['title'] },
    createdAt: '2025-01-01T02:00:00Z',
  },
];

const SEEDED_IMPACT_GRAPH = {
  documentId: SEED.DOC_API_SPEC_ID,
  nodes: [
    {
      id: '00000000-0000-0000-0000-000000000500',
      eventType: 'doc_edit',
      actorName: 'Dev User',
      intent: 'Edited fields: content',
      driftFlag: false,
      commitSha: null,
      ticketId: null,
      metadata: { fields: ['content'] },
      createdAt: '2025-01-01T00:00:00Z',
    },
    {
      id: '00000000-0000-0000-0000-000000000501',
      eventType: 'ticket_created',
      actorName: 'Dev User',
      intent: 'Created ticket: Implement auth endpoints',
      driftFlag: true,
      commitSha: null,
      ticketId: SEED.TKT_GH_OPEN_ID,
      metadata: { provider: 'github', title: 'Implement auth endpoints' },
      createdAt: '2025-01-01T01:00:00Z',
    },
    {
      id: '00000000-0000-0000-0000-000000000502',
      eventType: 'code_commit',
      actorName: 'Dev User',
      intent: 'fix: implement auth',
      driftFlag: false,
      commitSha: 'abc1234',
      ticketId: null,
      metadata: { message: 'fix: implement auth' },
      createdAt: '2025-01-01T02:00:00Z',
    },
  ],
  edges: [
    { source: '00000000-0000-0000-0000-000000000500', target: '00000000-0000-0000-0000-000000000501' },
    { source: '00000000-0000-0000-0000-000000000501', target: '00000000-0000-0000-0000-000000000502' },
  ],
};

// Templates — built-in templates returned by GET /api/templates.
// Names match real built-in templates seeded in apps/api/src/db/seed-templates.ts
// so tests can assert on full names.
const SEEDED_TEMPLATES = [
  {
    id: '00000000-0000-0000-0000-0000000009a0',
    stage: 'conception',
    name: 'Problem Statement',
    description: 'Define the problem you are solving and for whom',
    content: '# Problem Statement\n',
    sortOrder: 0,
    teamId: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
  {
    id: '00000000-0000-0000-0000-0000000009a1',
    stage: 'conception',
    name: 'Value Proposition Canvas',
    description: 'Map customer jobs, pains, and gains against your value map',
    content: '# Value Proposition Canvas\n',
    sortOrder: 1,
    teamId: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
  {
    id: '00000000-0000-0000-0000-0000000009a2',
    stage: 'definition',
    name: 'Product Requirements Document (PRD)',
    description: 'Complete product specification with goals, user stories, and requirements',
    content: '# Product Requirements Document\n',
    sortOrder: 0,
    teamId: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
  {
    id: '00000000-0000-0000-0000-0000000009a3',
    stage: 'architecture',
    name: 'Architecture Decision Record (ADR)',
    description: 'Document a significant architectural decision',
    content: '# ADR\n',
    sortOrder: 0,
    teamId: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  },
];

// ── Helper to install all API mocks on a page ───────────────────────

let _newDocCounter = 0;
let _createdDocs: Array<Record<string, unknown>> = [];
let _restoredDocIds: Set<string> = new Set();
let _deletedDocIds: Set<string> = new Set();
let _generatedProposals: Array<Record<string, unknown>> = [];

async function setupApiMocks(page: Page) {
  // Reset per-test mutable state
  _newDocCounter = 0;
  _createdDocs = [];
  _restoredDocIds = new Set();
  _deletedDocIds = new Set();
  _generatedProposals = [];

  // ── Clerk bypass ────────────────────────────────────────────────
  // When the dev server has VITE_CLERK_PUBLISHABLE_KEY set, the app uses
  // ClerkAuthGuard which redirects to a real Clerk sign-in page. To avoid
  // this in E2E tests, intercept the Vite-served source modules and replace
  // the env var reference with an empty string so the app falls back to
  // DevAuthGuard (which uses /api/auth/me — mocked below).
  for (const mod of ['src/main.tsx', 'src/App.tsx', 'src/components/AuthGuard.tsx']) {
    await page.route(`**/${mod}*`, async (route) => {
      try {
        const response = await route.fetch();
        const body = (await response.text()).replace(
          /import\.meta\.env\.VITE_CLERK_PUBLISHABLE_KEY/g,
          '""',
        );
        await route.fulfill({ response, body });
      } catch {
        // ECONNRESET under heavy parallelism — retry once
        try {
          const response = await route.fetch();
          const body = (await response.text()).replace(
            /import\.meta\.env\.VITE_CLERK_PUBLISHABLE_KEY/g,
            '""',
          );
          await route.fulfill({ response, body });
        } catch {
          await route.fallback();
        }
      }
    });
  }

  // Auth
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SEEDED_USER) }),
  );

  // Teams — single handler for all /api/teams* routes
  await page.route('**/api/teams**', (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const pathname = new URL(url).pathname;

    // Team member by ID: /api/teams/:id/members/:userId
    if (/\/teams\/[^/]+\/members\/[^/]+/.test(pathname)) {
      if (method === 'PATCH') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'tm-2', role: 'viewer' }),
        });
      }
      if (method === 'DELETE') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return route.fallback();
    }

    // Team members: /api/teams/:id/members
    if (/\/teams\/[^/]+\/members$/.test(pathname)) {
      if (method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ teamId: SEED.DEFAULT_TEAM_ID, members: [...SEEDED_MEMBERS] }),
        });
      }
      if (method === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'new-invite-1' }),
        });
      }
      return route.fallback();
    }

    // Invitation by ID: /api/teams/:id/invitations/:invId
    if (/\/teams\/[^/]+\/invitations\/[^/]+/.test(pathname)) {
      if (method === 'DELETE') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return route.fallback();
    }

    // Team invitations: /api/teams/:id/invitations
    if (/\/teams\/[^/]+\/invitations$/.test(pathname)) {
      if (method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ teamId: SEED.DEFAULT_TEAM_ID, invitations: [...SEEDED_INVITATIONS] }),
        });
      }
      return route.fallback();
    }

    // Teams list: /api/teams
    if (/\/teams$/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SEEDED_TEAMS) });
    }

    return route.fallback();
  });

  // Documents — single catch-all handler for all /api/documents* routes
  // Uses a single route to avoid LIFO ordering issues between overlapping patterns.
  await page.route('**/api/documents**', (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;

    // --- Sub-resource routes: /api/documents/:id/versions ---
    if (/\/documents\/[^/]+\/versions/.test(pathname)) {
      if (method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SEEDED_VERSIONS) });
      }
      if (method === 'POST') {
        const newVer = {
          id: `new-ver-${Date.now()}`,
          documentId: SEED.DOC_API_SPEC_ID,
          version: 3,
          content: SEEDED_DOCUMENTS[0].content,
          message: 'E2E test version',
          createdById: SEED.DEV_USER_ID,
          createdAt: new Date().toISOString(),
        };
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(newVer) });
      }
      return route.fallback();
    }

    // --- Sub-resource routes: /api/documents/:id/timeline ---
    if (/\/documents\/[^/]+\/timeline/.test(pathname)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ documentId: SEED.DOC_API_SPEC_ID, events: SEEDED_TIMELINE_EVENTS }),
      });
    }

    // --- Sub-resource routes: /api/documents/:id/audit-trail ---
    if (/\/documents\/[^/]+\/audit-trail/.test(pathname)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ documentId: SEED.DOC_API_SPEC_ID, events: SEEDED_AUDIT_EVENTS }),
      });
    }

    // --- Sub-resource routes: /api/documents/:id/impact-graph ---
    if (/\/documents\/[^/]+\/impact-graph/.test(pathname)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SEEDED_IMPACT_GRAPH),
      });
    }

    // --- Sub-resource routes: /api/documents/:id/change-proposals/generate ---
    if (/\/documents\/[^/]+\/change-proposals\/generate/.test(pathname)) {
      const proposal = {
        id: 'proposal-1',
        documentId: SEED.DOC_API_SPEC_ID,
        teamId: SEED.DEFAULT_TEAM_ID,
        createdById: SEED.DEV_USER_ID,
        title: 'Add authentication section',
        description: 'The document is missing authentication details',
        status: 'pending',
        suggestedTickets: [
          { title: 'Implement JWT auth', description: 'Add JWT authentication', priority: 'high', labels: [] },
          { title: 'Add auth middleware', description: 'Add middleware', priority: 'medium', labels: [] },
        ],
        sourceVersions: [SEED.VER_API_V2_ID],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      _generatedProposals.push(proposal);
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(proposal),
      });
    }

    // --- Sub-resource routes: /api/documents/:id/change-proposals ---
    if (/\/documents\/[^/]+\/change-proposals/.test(pathname)) {
      if (method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([..._generatedProposals]) });
      }
      return route.fallback();
    }

    // --- Sub-resource routes: /api/documents/:id/branches ---
    if (/\/documents\/[^/]+\/branches/.test(pathname)) {
      if (method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      }
      if (method === 'POST') {
        const body = route.request().postDataJSON?.() ?? {};
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'branch-1',
            documentId: SEED.DOC_API_SPEC_ID,
            name: body.name ?? 'e2e-test-branch',
            baseVersionId: SEED.VER_API_V2_ID,
            content: SEEDED_DOCUMENTS[0].content,
            createdById: SEED.DEV_USER_ID,
            status: 'open',
            reviewedById: null,
            createdAt: new Date().toISOString(),
            mergedAt: null,
          }),
        });
      }
      return route.fallback();
    }

    // --- Sub-resource routes: /api/documents/:id/export/* ---
    if (/\/documents\/[^/]+\/export/.test(pathname)) {
      return route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="document.md"',
        },
        body: '# Exported Document',
      });
    }

    // --- Document list: /api/documents?teamId=... ---
    // Match when there's a query string with teamId or the pathname is exactly /api/documents
    const isListRoute = /\/api\/documents$/.test(pathname);
    if (isListRoute && method === 'GET') {
      const teamIdParam = urlObj.searchParams.get('teamId');
      const includeArchived = urlObj.searchParams.get('includeArchived');
      if (teamIdParam === SEED.SECOND_TEAM_ID) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SEEDED_SECOND_TEAM_DOCS) });
      }
      const activeDocs = SEEDED_DOCUMENTS.filter((d) => !_deletedDocIds.has(d.id));
      const newlyDeleted = SEEDED_DOCUMENTS.filter((d) => _deletedDocIds.has(d.id)).map((d) => ({ ...d, status: 'archived' }));
      const archivedDocs = [...SEEDED_ARCHIVED_DOCS.filter((d) => !_restoredDocIds.has(d.id)), ...newlyDeleted];
      const docs = includeArchived === 'true'
        ? [...activeDocs, ...archivedDocs]
        : activeDocs;

      const sortParam = urlObj.searchParams.get('sort');
      const limitParam = urlObj.searchParams.get('limit');

      let result = [...docs];
      if (sortParam === 'name') {
        result.sort((a: any, b: any) => (a.title ?? '').localeCompare(b.title ?? ''));
      } else {
        result.sort((a: any, b: any) => new Date(b.updatedAt as string).getTime() - new Date(a.updatedAt as string).getTime());
      }

      if (limitParam) {
        const n = parseInt(limitParam, 10);
        if (!isNaN(n) && n > 0) result = result.slice(0, n);
      }

      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
    }

    // --- Create document: POST /api/documents ---
    if (isListRoute && method === 'POST') {
      const body = route.request().postDataJSON?.() ?? {};
      const newDoc = {
        id: `new-doc-${++_newDocCounter}`,
        title: body.title ?? 'Untitled Document',
        content: body.content ?? '',
        path: body.path ?? '/',
        status: 'draft',
        teamId: body.teamId ?? SEED.DEFAULT_TEAM_ID,
        createdById: SEED.DEV_USER_ID,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      _createdDocs.push(newDoc);
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(newDoc) });
    }

    // --- Single document by ID: /api/documents/:id ---
    const singleDocMatch = pathname.match(/\/api\/documents\/([^/]+)$/);
    if (singleDocMatch) {
      const docId = singleDocMatch[1];
      if (method === 'GET') {
        const allDocs = [...SEEDED_DOCUMENTS, ...SEEDED_ARCHIVED_DOCS, ...SEEDED_SECOND_TEAM_DOCS, ..._createdDocs];
        const doc = allDocs.find((d) => d.id === docId);
        if (doc) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(doc) });
        }
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Document not found' }) });
      }
      if (method === 'POST') {
        const newDoc = {
          id: `new-doc-${++_newDocCounter}`,
          title: 'Untitled Document',
          content: '',
          path: '/',
          status: 'draft',
          teamId: SEED.DEFAULT_TEAM_ID,
          createdById: SEED.DEV_USER_ID,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(newDoc) });
      }
      if (method === 'PUT') {
        const allDocs = [...SEEDED_DOCUMENTS, ...SEEDED_ARCHIVED_DOCS, ...SEEDED_SECOND_TEAM_DOCS, ..._createdDocs];
        const doc = allDocs.find((d) => d.id === docId);
        const body = route.request().postDataJSON?.() ?? {};
        // Track status changes (e.g., restoring from trash sets status to 'draft')
        if (body.status === 'draft' && SEEDED_ARCHIVED_DOCS.some((d) => d.id === docId)) {
          _restoredDocIds.add(docId);
        }
        const updated = { ...(doc ?? SEEDED_DOCUMENTS[0]), ...body, updatedAt: new Date().toISOString() };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(updated) });
      }
      if (method === 'DELETE') {
        _deletedDocIds.add(docId);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: docId, status: 'archived' }) });
      }
    }

    return route.fallback();
  });

  // Diff
  await page.route('**/api/versions/*/diff/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ a: SEEDED_VERSIONS[0], b: SEEDED_VERSIONS[1] }),
    }),
  );

  // Audit trace
  await page.route('**/api/audit-trail/*/trace', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        eventId: '00000000-0000-0000-0000-000000000502',
        chain: [SEEDED_AUDIT_EVENTS[2], SEEDED_AUDIT_EVENTS[1]],
      }),
    }),
  );

  // Tickets — single handler for all /api/tickets* routes
  await page.route('**/api/tickets**', (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const pathname = new URL(url).pathname;

    // Insights refresh: POST /api/tickets/:id/insights/refresh
    if (/\/tickets\/[^/]+\/insights\/refresh/.test(pathname) && method === 'POST') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SEEDED_INSIGHT),
      });
    }

    // Insights get: GET /api/tickets/:id/insights
    if (/\/tickets\/[^/]+\/insights$/.test(pathname) && method === 'GET') {
      const ticketId = pathname.match(/\/tickets\/([^/]+)\/insights/)?.[1];
      const ticket = SEEDED_TICKETS.find((t) => t.id === ticketId);
      if (ticket?.claudeInsights) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(ticket.claudeInsights),
        });
      }
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No Claude insight found for this ticket' }),
      });
    }

    // Tickets sync
    if (/\/tickets\/sync/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ synced: 4 }) });
    }

    // POST to create ticket
    if (method === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'new-ticket-1', title: 'New ticket', status: 'open' }),
      });
    }

    // GET tickets list
    if (method === 'GET') {
      const params = new URL(url).searchParams;
      const provider = params.get('provider');
      let tickets = [...SEEDED_TICKETS];
      if (provider && provider !== '') {
        tickets = tickets.filter((t) => t.provider === provider);
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tickets) });
    }

    return route.fallback();
  });

  // Integrations — single handler
  await page.route('**/api/integrations**', (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const pathname = new URL(url).pathname;

    // GitHub repos sub-route
    if (/\/github\/repos/.test(pathname)) {
      if (method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ repos: mockGitHubRepos() }),
        });
      }
      if (method === 'PUT' || method === 'POST') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      return route.fallback();
    }

    // Test endpoint
    if (/\/test$/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, message: 'connected' }) });
    }

    // Single integration by ID
    if (/\/integrations\/[^/]+$/.test(pathname)) {
      if (method === 'DELETE') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'deleted' }) });
      }
      if (method === 'PATCH') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
    }

    // Integrations list
    if (/\/integrations$/.test(pathname) && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SEEDED_INTEGRATIONS) });
    }

    return route.fallback();
  });

  // API Keys — single handler
  await page.route('**/api/api-keys**', (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const pathname = new URL(url).pathname;

    // Single key by ID (DELETE to revoke)
    if (/\/api-keys\/[^/]+$/.test(pathname) && method === 'DELETE') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revoked: true }) });
    }

    // Create key
    if (/\/api-keys$/.test(pathname) && method === 'POST') {
      const body = route.request().postDataJSON?.() ?? {};
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'new-key-1',
          name: body.name ?? 'New Key',
          keyPrefix: 'sd_new',
          scopes: body.scopes ?? ['read', 'write'],
          lastUsedAt: null,
          expiresAt: null,
          revoked: false,
          createdAt: new Date().toISOString(),
          key: 'sd_new_test_key_abc123',
        }),
      });
    }

    // List keys
    if (method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SEEDED_API_KEYS) });
    }

    return route.fallback();
  });

  // Change proposals (non-document-scoped)
  await page.route('**/api/change-proposals/**', (route) => {
    const url = route.request().url();
    const pathname = new URL(url).pathname;

    if (/\/approve$/.test(pathname)) {
      const p = _generatedProposals.find((x) => (x as { id: string }).id === 'proposal-1');
      if (p) (p as Record<string, unknown>).status = 'approved';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'proposal-1', status: 'approved', title: 'Add authentication section' }),
      });
    }
    if (/\/reject$/.test(pathname)) {
      const p = _generatedProposals.find((x) => (x as { id: string }).id === 'proposal-1');
      if (p) (p as Record<string, unknown>).status = 'rejected';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'proposal-1', status: 'rejected', title: 'Add authentication section' }),
      });
    }
    if (/\/push$/.test(pathname)) {
      const p = _generatedProposals.find((x) => (x as { id: string }).id === 'proposal-1');
      if (p) (p as Record<string, unknown>).status = 'pushed';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          proposal: { id: 'proposal-1', status: 'pushed', title: 'Add authentication section' },
          createdTickets: [{ id: 'ticket-1', title: 'Implement JWT auth', status: 'open' }],
        }),
      });
    }
    return route.fallback();
  });

  // User profile
  await page.route('**/api/users/me', (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON?.() ?? {};
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: SEED.DEV_USER_ID, name: body.name ?? 'Dev User', email: body.email ?? SEED.DEV_EMAIL }),
      });
    }
    if (route.request().method() === 'DELETE') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.fallback();
  });

  // Agent workflows
  await page.route('**/api/agent/workflows', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'wf-1', name: 'Sync Spec', description: 'Sync specification with code' },
        { id: 'wf-2', name: 'Auto Review', description: 'Automatic document review' },
      ]),
    }),
  );

  // AI — single handler for all /api/ai/* routes
  await page.route('**/api/ai/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;

    if (/\/ai\/analyze/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockQualityResponse()) });
    }
    if (/\/ai\/edit-document/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockEditResponse()) });
    }
    if (/\/ai\/generate-document/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockGenerateResponse()) });
    }
    return route.fallback();
  });

  // Templates — used by the TemplatePicker modal (FileTree "New from template")
  await page.route('**/api/templates**', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SEEDED_TEMPLATES),
    });
  });

  // Waitlist
  await page.route('**/api/waitlist', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
    }
    return route.fallback();
  });
}

/** Shared fixtures for Nyx E2E tests. */
type NyxFixtures = {
  /** A page already authenticated via dev bypass and on /dashboard. */
  authenticatedPage: Page;
  /** Helper to intercept all AI API routes with canned responses. */
  mockAI: (page: Page, overrides?: { quality?: object; edit?: object; generate?: object; drift?: object; proposals?: object }) => Promise<void>;
  /** Helper to intercept GitHub API calls. */
  mockGitHub: (page: Page) => Promise<void>;
};

export const test = base.extend<NyxFixtures>({
  authenticatedPage: async ({ page }, use) => {
    await setupApiMocks(page);
    await page.goto('/app/dashboard');
    // Wait for the sidebar logo to confirm auth loaded
    await page.waitForSelector('a:has-text("Nyx")', { timeout: 30_000 });
    // Wait for the user section to load (confirms auth/me resolved)
    await page.waitForSelector('aside >> text=Dev User', { timeout: 10_000 }).catch(() => {});
    // Wait for team switcher to confirm teams are loaded (select only renders when teams.length > 1)
    await page.waitForSelector('[data-testid="team-switcher"]', { timeout: 10_000 }).catch(() => {});
    await use(page);
  },

  mockAI: async ({}, use) => {
    const setup = async (page: Page, overrides?: Parameters<NyxFixtures['mockAI']>[1]) => {
      // Override the AI handler registered in setupApiMocks with a single handler
      await page.route('**/api/ai/**', (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (/\/ai\/quality/.test(pathname) || /\/ai\/analyze/.test(pathname)) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overrides?.quality ?? mockQualityResponse()) });
        }
        if (/\/ai\/edit-document/.test(pathname)) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overrides?.edit ?? mockEditResponse()) });
        }
        if (/\/ai\/edit/.test(pathname)) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overrides?.edit ?? mockEditResponse()) });
        }
        if (/\/ai\/generate/.test(pathname)) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overrides?.generate ?? mockGenerateResponse()) });
        }
        if (/\/ai\/drift/.test(pathname)) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overrides?.drift ?? mockDriftResponse()) });
        }
        if (/\/ai\/proposals/.test(pathname)) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(overrides?.proposals ?? mockProposalResponse()) });
        }
        return route.fallback();
      });
    };
    await use(setup);
  },

  mockGitHub: async ({}, use) => {
    const setup = async (page: Page) => {
      await page.route('https://api.github.com/user/repos**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockGitHubRepos()) }),
      );
      await page.route('https://api.github.com/repos/*/issues', (route) =>
        route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(mockGitHubIssue()) }),
      );
    };
    await use(setup);
  },
});

export { expect, SEED };
