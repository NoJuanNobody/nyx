import 'dotenv/config';
import { eq, and } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from './index.js';
import {
  users, teams, teamMembers, teamInvitations,
  documents, documentVersions, integrations, tickets,
  auditTrail, timelineEvents, apiKeys, documentTemplates,
} from './schema.js';

// ── Development-only guard ────────────────────────────────────────
const NODE_ENV = process.env.NODE_ENV || 'development';

if (NODE_ENV === 'production') {
  console.error(
    '\n[seed] ERROR: Refusing to run seed data in production (NODE_ENV=production).\n' +
      'This seed file contains mock/dev-only data and must not be used in production.\n',
  );
  process.exit(1);
}

// ── Hardcoded IDs for deterministic, idempotent seeding ───────────
// All IDs use a recognizable pattern: 00000000-0000-0000-0000-00000000XXXX

const ID = {
  // Users
  DEV_USER:     '00000000-0000-0000-0000-000000000000',
  ALICE:        '00000000-0000-0000-0000-000000000010',
  BOB:          '00000000-0000-0000-0000-000000000011',

  // Teams
  DEFAULT_TEAM: '00000000-0000-0000-0000-000000000001',
  SECOND_TEAM:  '00000000-0000-0000-0000-000000000002',

  // Documents
  DOC_API_SPEC:     '00000000-0000-0000-0000-000000000100',
  DOC_ARCHITECTURE: '00000000-0000-0000-0000-000000000101',
  DOC_DEPRECATED:   '00000000-0000-0000-0000-000000000102',
  DOC_QUICKSTART:   '00000000-0000-0000-0000-000000000103',
  DOC_SECOND_TEAM:  '00000000-0000-0000-0000-000000000104',

  // Document Versions
  VER_API_V1: '00000000-0000-0000-0000-000000000200',
  VER_API_V2: '00000000-0000-0000-0000-000000000201',
  VER_ARCH_V1: '00000000-0000-0000-0000-000000000202',

  // Integrations
  INT_GITHUB: '00000000-0000-0000-0000-000000000300',
  INT_JIRA:   '00000000-0000-0000-0000-000000000301',

  // Tickets
  TKT_GH_OPEN:    '00000000-0000-0000-0000-000000000400',
  TKT_GH_CLOSED:  '00000000-0000-0000-0000-000000000401',
  TKT_JIRA_OPEN:  '00000000-0000-0000-0000-000000000402',
  TKT_JIRA_INPROG: '00000000-0000-0000-0000-000000000403',

  // Audit Trail
  AUDIT_DOC_EDIT:      '00000000-0000-0000-0000-000000000500',
  AUDIT_TICKET_CREATE: '00000000-0000-0000-0000-000000000501',
  AUDIT_DOC_EDIT_2:    '00000000-0000-0000-0000-000000000502',

  // Timeline Events
  TL_DOC_UPDATED:    '00000000-0000-0000-0000-000000000600',
  TL_VERSION_CREATED: '00000000-0000-0000-0000-000000000601',

  // Invitation
  INVITATION_PENDING: '00000000-0000-0000-0000-000000000700',

  // API Key
  API_KEY_CICD: '00000000-0000-0000-0000-000000000800',
} as const;

// ── Rich markdown content for documents ───────────────────────────

const API_SPEC_CONTENT = `# API Specification

## Authentication

All API endpoints require authentication via Bearer token (JWT or API key).

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/documents | List all documents |
| POST | /api/documents | Create a document |
| GET | /api/documents/:id | Get document by ID |
| PUT | /api/documents/:id | Update document |
| DELETE | /api/documents/:id | Archive document |

### Request Headers

\`\`\`
Authorization: Bearer <token>
Content-Type: application/json
\`\`\`

## Rate Limiting

API requests are rate-limited to **100 requests per minute** per API key.

### Error Responses

\`\`\`json
{
  "error": "Rate limit exceeded",
  "retryAfter": 60
}
\`\`\`
`;

const API_SPEC_V1_CONTENT = `# API Specification

## Authentication

All API endpoints require authentication via Bearer token.

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/documents | List all documents |
| POST | /api/documents | Create a document |
`;

const ARCHITECTURE_CONTENT = `# Architecture Overview

## System Design

Nyx uses a monorepo architecture with three main packages:

- **apps/api** — Fastify backend with PostgreSQL
- **apps/web** — React frontend with Vite
- **packages/shared** — Shared types and utilities

## Data Flow

1. User edits a document in the web editor
2. Changes are saved to PostgreSQL via the API
3. AI analyzes spec quality on save
4. GitHub webhooks detect code changes
5. Drift detection compares spec vs code

## Deployment

- Frontend: Vercel
- Backend: Railway
- Database: Neon PostgreSQL
`;

// ── Helper: idempotent team member insert ─────────────────────────

async function ensureMember(teamId: string, userId: string, role: 'owner' | 'admin' | 'developer' | 'editor' | 'viewer') {
  const existing = await db
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(teamMembers).values({ teamId, userId, role });
  }
}

// ── Main seed function ────────────────────────────────────────────

async function seed() {
  console.log(`\n[seed] Running DEVELOPMENT seed data (NODE_ENV=${NODE_ENV})...`);
  console.log('[seed] WARNING: This data is for local development only.\n');

  // ── Users (3) ──────────────────────────────────────────
  await db.insert(users).values([
    { id: ID.DEV_USER, email: 'dev@nyx.io', name: 'Dev User' },
    { id: ID.ALICE, email: 'alice@nyx.io', name: 'Alice Admin' },
    { id: ID.BOB, email: 'bob@nyx.io', name: 'Bob Viewer' },
  ]).onConflictDoNothing();
  console.log('[seed] Users: dev, alice, bob');

  // ── Teams (2) ──────────────────────────────────────────
  await db.insert(teams).values([
    { id: ID.DEFAULT_TEAM, name: 'Default Team', slug: 'default' },
    { id: ID.SECOND_TEAM, name: 'Second Team', slug: 'second-team' },
  ]).onConflictDoNothing();
  console.log('[seed] Teams: default, second-team');

  // ── Team Members (4) ──────────────────────────────────
  await ensureMember(ID.DEFAULT_TEAM, ID.DEV_USER, 'owner');
  await ensureMember(ID.DEFAULT_TEAM, ID.ALICE, 'admin');
  await ensureMember(ID.DEFAULT_TEAM, ID.BOB, 'viewer');
  await ensureMember(ID.SECOND_TEAM, ID.DEV_USER, 'owner');
  console.log('[seed] Team members: 4 memberships');

  // ── Documents (5) ─────────────────────────────────────
  await db.insert(documents).values([
    {
      id: ID.DOC_API_SPEC,
      title: 'API Specification',
      content: API_SPEC_CONTENT,
      path: '/api',
      teamId: ID.DEFAULT_TEAM,
      createdById: ID.DEV_USER,
    },
    {
      id: ID.DOC_ARCHITECTURE,
      title: 'Architecture Overview',
      content: ARCHITECTURE_CONTENT,
      path: '/',
      teamId: ID.DEFAULT_TEAM,
      createdById: ID.DEV_USER,
    },
    {
      id: ID.DOC_DEPRECATED,
      title: 'Deprecated Guide',
      content: '# Deprecated Guide\n\nThis document is no longer maintained.',
      path: '/api',
      // Previously seeded as status='archived'. After the draft/published/
      // archived enum was retired, soft-delete uses deletedAt instead — this
      // row is tombstoned at seed time so list endpoints hide it by default.
      deletedAt: new Date(),
      teamId: ID.DEFAULT_TEAM,
      createdById: ID.DEV_USER,
    },
    {
      id: ID.DOC_QUICKSTART,
      title: 'Quick Start',
      content: '# Quick Start\n\nGet up and running with Nyx in 5 minutes.',
      path: '/',
      teamId: ID.DEFAULT_TEAM,
      createdById: ID.DEV_USER,
    },
    {
      id: ID.DOC_SECOND_TEAM,
      title: 'Second Team Doc',
      content: '# Second Team\n\nDocumentation for the second team.',
      path: '/',
      teamId: ID.SECOND_TEAM,
      createdById: ID.DEV_USER,
    },
  ]).onConflictDoNothing();
  console.log('[seed] Documents: 5');

  // ── Document Versions (3) ─────────────────────────────
  await db.insert(documentVersions).values([
    {
      id: ID.VER_API_V1,
      documentId: ID.DOC_API_SPEC,
      version: 1,
      content: API_SPEC_V1_CONTENT,
      message: 'Initial draft',
      createdById: ID.DEV_USER,
    },
    {
      id: ID.VER_API_V2,
      documentId: ID.DOC_API_SPEC,
      version: 2,
      content: API_SPEC_CONTENT,
      message: 'Added endpoints',
      createdById: ID.DEV_USER,
    },
    {
      id: ID.VER_ARCH_V1,
      documentId: ID.DOC_ARCHITECTURE,
      version: 1,
      content: ARCHITECTURE_CONTENT,
      message: 'First draft',
      createdById: ID.DEV_USER,
    },
  ]).onConflictDoNothing();
  console.log('[seed] Document versions: 3');

  // ── Integrations (2) ──────────────────────────────────
  await db.insert(integrations).values([
    {
      id: ID.INT_GITHUB,
      teamId: ID.DEFAULT_TEAM,
      type: 'github',
      config: {
        accessToken: 'ghp_test_token_for_e2e_seeding',
        selectedRepos: [{ owner: 'nyx', name: 'app', fullName: 'nyx/app' }],
        webhookSecret: 'wh-secret-123',
      },
    },
    {
      id: ID.INT_JIRA,
      teamId: ID.DEFAULT_TEAM,
      type: 'jira',
      config: {
        baseUrl: 'https://nyx.atlassian.net',
        email: 'admin@nyx.io',
        apiToken: 'jira-token-for-e2e',
        projectKey: 'SD',
      },
    },
  ]).onConflictDoNothing();
  console.log('[seed] Integrations: github, jira');

  // ── Tickets (4) ───────────────────────────────────────
  await db.insert(tickets).values([
    {
      id: ID.TKT_GH_OPEN,
      documentId: ID.DOC_API_SPEC,
      provider: 'github',
      externalId: '101',
      externalUrl: 'https://github.com/nyx/app/issues/101',
      title: 'Implement auth endpoints',
      status: 'open',
      createdById: ID.DEV_USER,
    },
    {
      id: ID.TKT_GH_CLOSED,
      documentId: ID.DOC_API_SPEC,
      provider: 'github',
      externalId: '102',
      externalUrl: 'https://github.com/nyx/app/issues/102',
      title: 'Fix rate limiting',
      status: 'closed',
      createdById: ID.DEV_USER,
    },
    {
      id: ID.TKT_JIRA_OPEN,
      documentId: ID.DOC_ARCHITECTURE,
      provider: 'jira',
      externalId: 'SD-1',
      externalUrl: 'https://nyx.atlassian.net/browse/SD-1',
      title: 'Review architecture',
      status: 'open',
      createdById: ID.DEV_USER,
    },
    {
      id: ID.TKT_JIRA_INPROG,
      documentId: ID.DOC_ARCHITECTURE,
      provider: 'jira',
      externalId: 'SD-2',
      externalUrl: 'https://nyx.atlassian.net/browse/SD-2',
      title: 'Update deployment docs',
      status: 'in_progress',
      createdById: ID.DEV_USER,
    },
  ]).onConflictDoNothing();
  console.log('[seed] Tickets: 4');

  // ── Audit Trail (3) — with parent chaining ────────────
  await db.insert(auditTrail).values([
    {
      id: ID.AUDIT_DOC_EDIT,
      teamId: ID.DEFAULT_TEAM,
      eventType: 'doc_edit',
      actorId: ID.DEV_USER,
      documentId: ID.DOC_API_SPEC,
      metadata: { fields: ['content'] },
    },
    {
      id: ID.AUDIT_TICKET_CREATE,
      teamId: ID.DEFAULT_TEAM,
      eventType: 'ticket_created',
      actorId: ID.DEV_USER,
      documentId: ID.DOC_API_SPEC,
      ticketId: ID.TKT_GH_OPEN,
      metadata: { provider: 'github', title: 'Implement auth endpoints' },
    },
    {
      id: ID.AUDIT_DOC_EDIT_2,
      teamId: ID.DEFAULT_TEAM,
      eventType: 'doc_edit',
      actorId: ID.DEV_USER,
      documentId: ID.DOC_API_SPEC,
      parentEventId: ID.AUDIT_TICKET_CREATE,
      metadata: { fields: ['title'] },
    },
  ]).onConflictDoNothing();
  console.log('[seed] Audit trail events: 3');

  // ── Timeline Events (2) ───────────────────────────────
  await db.insert(timelineEvents).values([
    {
      id: ID.TL_DOC_UPDATED,
      documentId: ID.DOC_API_SPEC,
      type: 'document_updated',
      payload: { fields: ['content'] },
      actorId: ID.DEV_USER,
    },
    {
      id: ID.TL_VERSION_CREATED,
      documentId: ID.DOC_API_SPEC,
      type: 'version_created',
      payload: { version: 1, message: 'Initial draft' },
      actorId: ID.DEV_USER,
    },
  ]).onConflictDoNothing();
  console.log('[seed] Timeline events: 2');

  // ── Team Invitation (1) ───────────────────────────────
  await db.insert(teamInvitations).values({
    id: ID.INVITATION_PENDING,
    teamId: ID.DEFAULT_TEAM,
    email: 'pending@nyx.io',
    role: 'developer',
    invitedById: ID.DEV_USER,
    token: 'e2e-invite-token-0001',
    status: 'pending',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
  }).onConflictDoNothing();
  console.log('[seed] Invitations: 1 pending');

  // ── API Key (1) ───────────────────────────────────────
  const keyHash = createHash('sha256').update('sd_test_cicd_key_12345').digest('hex');
  await db.insert(apiKeys).values({
    id: ID.API_KEY_CICD,
    teamId: ID.DEFAULT_TEAM,
    userId: ID.DEV_USER,
    name: 'CI/CD Key',
    keyHash,
    keyPrefix: 'sd_test_cicd',
    scopes: ['read', 'write'],
    revoked: false,
  }).onConflictDoNothing();
  console.log('[seed] API keys: 1');

  // ── Document Templates (20) — 4 per lifecycle stage ─────
  // Clear existing templates first to avoid duplicates on re-run
  await db.delete(documentTemplates);
  await db.insert(documentTemplates).values([
    // Conception
    { stage: 'conception', name: 'Problem Statement', description: 'Define the problem you are solving and for whom', content: '# Problem Statement\n\n## The Problem\n<!-- What specific problem are you solving? Who experiences it? -->\n\n## Current Solutions\n<!-- How do people solve this today? What\'s broken about existing approaches? -->\n\n## Target Users\n<!-- Who are the primary users? What are their characteristics? -->\n\n## Impact\n<!-- What happens if this problem remains unsolved? What\'s the cost? -->\n\n## Proposed Direction\n<!-- High-level idea for a solution (not detailed spec — just direction) -->\n', sortOrder: 0 },
    { stage: 'conception', name: 'Value Proposition Canvas', description: 'Map customer jobs, pains, and gains against your value map', content: '# Value Proposition Canvas\n\n## Customer Profile\n\n### Jobs to Be Done\n- \n\n### Pains\n- \n\n### Gains\n- \n\n## Value Map\n\n### Products & Services\n- \n\n### Pain Relievers\n- \n\n### Gain Creators\n- \n', sortOrder: 1 },
    { stage: 'conception', name: 'Market Analysis', description: 'Analyze market size, competition, and trends', content: '# Market Analysis\n\n## Market Size\n<!-- TAM, SAM, SOM estimates -->\n\n## Competitive Landscape\n| Competitor | Strengths | Weaknesses | Differentiator |\n|-----------|-----------|------------|----------------|\n|           |           |            |                |\n\n## Trends\n<!-- What market trends support this direction? -->\n\n## Risks\n<!-- What could prevent market adoption? -->\n', sortOrder: 2 },
    { stage: 'conception', name: 'Rough Notes', description: 'Capture unstructured ideas and brain dumps', content: '# Rough Notes\n\n## Key Ideas\n- \n\n## Open Questions\n- \n\n## References\n- \n\n## Next Steps\n- \n', sortOrder: 3 },
    // Definition
    { stage: 'definition', name: 'Product Requirements Document (PRD)', description: 'Complete product specification with goals, user stories, and requirements', content: '# Product Requirements Document\n\n## Overview\n<!-- One-paragraph summary of what we\'re building and why -->\n\n## Goals & Success Metrics\n| Goal | Metric | Target |\n|------|--------|--------|\n|      |        |        |\n\n## User Stories\n\n### As a [user type]\n- I want to [action] so that [benefit]\n\n## Functional Requirements\n\n### Must Have (P0)\n- [ ] \n\n### Should Have (P1)\n- [ ] \n\n### Nice to Have (P2)\n- [ ] \n\n## Non-Functional Requirements\n- Performance: \n- Security: \n- Scalability: \n\n## Out of Scope\n- \n\n## Timeline\n| Milestone | Date | Description |\n|-----------|------|-------------|\n|           |      |             |\n', sortOrder: 0 },
    { stage: 'definition', name: 'User Stories & Personas', description: 'Define user personas and map their stories', content: '# User Stories & Personas\n\n## Personas\n\n### Persona 1: [Name]\n- **Role:** \n- **Goals:** \n- **Pain Points:** \n- **Tech Comfort:** \n\n## User Stories\n\n### Epic: [Epic Name]\n| ID | Story | Acceptance Criteria | Priority |\n|----|-------|-------------------|----------|\n|    |       |                   |          |\n', sortOrder: 1 },
    { stage: 'definition', name: 'Feature Specification', description: 'Detailed specification for a single feature', content: '# Feature Specification\n\n## Feature: [Name]\n\n### Summary\n<!-- What does this feature do? -->\n\n### User Flow\n1. \n2. \n3. \n\n### UI/UX Requirements\n<!-- Wireframes, mockups, or detailed descriptions -->\n\n### Business Rules\n- \n\n### Edge Cases\n- \n\n### Dependencies\n- \n', sortOrder: 2 },
    { stage: 'definition', name: 'Competitive Analysis', description: 'Compare your product against competitors', content: '# Competitive Analysis\n\n## Our Product\n<!-- One-line description -->\n\n## Competitors\n\n### [Competitor 1]\n- **What they do well:** \n- **What they miss:** \n- **Pricing:** \n- **Target audience:** \n\n## Feature Comparison\n| Feature | Us | Competitor 1 | Competitor 2 |\n|---------|-----|-------------|-------------|\n|         |     |             |             |\n\n## Our Advantage\n<!-- What makes us different? -->\n', sortOrder: 3 },
    // Architecture
    { stage: 'architecture', name: 'Architecture Decision Record (ADR)', description: 'Document a significant architectural decision', content: '# ADR: [Decision Title]\n\n## Status\nProposed | Accepted | Deprecated | Superseded\n\n## Context\n<!-- What is the technical context? What forces are at play? -->\n\n## Decision\n<!-- What is the change that we\'re proposing? -->\n\n## Consequences\n\n### Positive\n- \n\n### Negative\n- \n\n### Risks\n- \n\n## Alternatives Considered\n| Option | Pros | Cons |\n|--------|------|------|\n|        |      |      |\n', sortOrder: 0 },
    { stage: 'architecture', name: 'Data Model Design', description: 'Design database entities, relationships, and indexes', content: '# Data Model Design\n\n## Entities\n\n### [Entity Name]\n| Field | Type | Required | Description |\n|-------|------|----------|-------------|\n|       |      |          |             |\n\n## Relationships\n<!-- Entity relationship descriptions or diagram references -->\n\n## Indexes\n- \n\n## Migration Notes\n- \n', sortOrder: 1 },
    { stage: 'architecture', name: 'API Contract', description: 'Define API endpoints, request/response schemas, and auth', content: '# API Contract\n\n## Base URL\n`https://api.example.com/v1`\n\n## Authentication\n<!-- How do clients authenticate? -->\n\n## Endpoints\n\n### [POST /resource]\n**Description:** \n\n**Request Body:**\n```json\n{}\n```\n\n**Response (201):**\n```json\n{}\n```\n\n**Error Responses:**\n| Status | Description |\n|--------|-------------|\n| 400    |             |\n| 401    |             |\n\n## Rate Limits\n- \n', sortOrder: 2 },
    { stage: 'architecture', name: 'Component Specification', description: 'Specify a system component: interface, state, and behavior', content: '# Component Specification\n\n## Component: [Name]\n\n### Purpose\n<!-- What does this component do? -->\n\n### Interface\n<!-- Props, inputs, events, outputs -->\n\n### Internal State\n<!-- What state does it manage? -->\n\n### Dependencies\n- \n\n### Error Handling\n- \n\n### Performance Considerations\n- \n', sortOrder: 3 },
    // Implementation
    { stage: 'implementation', name: 'AI-Ready Implementation Spec', description: 'Implementation spec optimized for AI coding agents', content: '# Implementation Spec: [Feature Name]\n\n## Context\n<!-- Link to PRD section and architecture decisions -->\n\n## Scope\n<!-- Exactly what code changes are needed -->\n\n## Technical Approach\n\n### Step 1: [Description]\n- Files to modify: \n- Changes: \n\n## Acceptance Criteria\n- [ ] \n\n## Test Plan\n- [ ] Unit: \n- [ ] Integration: \n- [ ] E2E: \n\n## Edge Cases\n| Scenario | Expected Behavior |\n|----------|------------------|\n|          |                  |\n\n## Rollback Plan\n<!-- How to revert if something goes wrong -->\n', sortOrder: 0 },
    { stage: 'implementation', name: 'Ticket Breakdown', description: 'Break a feature into actionable development tickets', content: '# Ticket Breakdown: [Feature Name]\n\n## Overview\n<!-- What feature or epic are these tickets for? -->\n\n## Tickets\n\n### Ticket 1: [Title]\n- **Type:** Feature | Bug | Chore\n- **Priority:** P0 | P1 | P2\n- **Estimate:** \n- **Description:** \n- **Acceptance Criteria:**\n  - [ ] \n- **Dependencies:** None\n', sortOrder: 1 },
    { stage: 'implementation', name: 'Test Plan', description: 'Comprehensive test plan with unit, integration, and E2E cases', content: '# Test Plan: [Feature Name]\n\n## Scope\n<!-- What is being tested? -->\n\n## Test Cases\n\n### Unit Tests\n| ID | Description | Input | Expected Output |\n|----|-------------|-------|-----------------|\n|    |             |       |                 |\n\n### Integration Tests\n| ID | Description | Setup | Expected Result |\n|----|-------------|-------|-----------------|\n|    |             |       |                 |\n\n### E2E Tests\n| ID | User Flow | Steps | Expected Result |\n|----|-----------|-------|-----------------|\n|    |           |       |                 |\n\n## Edge Cases\n- \n\n## Performance Benchmarks\n- \n', sortOrder: 2 },
    { stage: 'implementation', name: 'Edge Cases & Error Handling', description: 'Document error scenarios and boundary conditions', content: '# Edge Cases & Error Handling\n\n## Feature: [Name]\n\n## Error Scenarios\n\n### [Scenario 1]\n- **Trigger:** \n- **Expected behavior:** \n- **User message:** \n- **Recovery:** \n\n## Boundary Conditions\n| Input | Min | Max | Invalid |\n|-------|-----|-----|--------|\n|       |     |     |        |\n\n## Concurrency Issues\n- \n\n## Data Integrity\n- \n', sortOrder: 3 },
    // Execution
    { stage: 'execution', name: 'Release Notes', description: 'Document a release with highlights, features, and fixes', content: '# Release Notes — v[X.Y.Z]\n\n**Release Date:** YYYY-MM-DD\n\n## Highlights\n<!-- 1-2 sentence summary of the release -->\n\n## New Features\n- \n\n## Improvements\n- \n\n## Bug Fixes\n- \n\n## Breaking Changes\n- \n\n## Migration Guide\n<!-- Steps for users to upgrade -->\n\n## Known Issues\n- \n', sortOrder: 0 },
    { stage: 'execution', name: 'Changelog', description: 'Running log of all notable changes', content: '# Changelog\n\nAll notable changes to this project are documented here.\n\n## [Unreleased]\n\n### Added\n- \n\n### Changed\n- \n\n### Fixed\n- \n\n### Removed\n- \n', sortOrder: 1 },
    { stage: 'execution', name: 'Drift Report', description: 'Report on spec-code drift with severity and actions', content: '# Drift Report\n\n**Generated:** YYYY-MM-DD\n**Spec Version:** \n**Code Commit:** \n\n## Summary\n<!-- Overall drift status -->\n\n## Drift Items\n\n### [Area 1]\n- **Spec says:** \n- **Code does:** \n- **Severity:** Low | Medium | High\n- **Action:** Update spec | Update code | Investigate\n\n## No Drift\n- [List areas where spec and code are in sync]\n\n## Recommendations\n- \n', sortOrder: 2 },
    { stage: 'execution', name: 'Deployment Notes', description: 'Pre/post deployment checklist and rollback procedure', content: '# Deployment Notes — v[X.Y.Z]\n\n## Pre-Deployment Checklist\n- [ ] Database migrations reviewed\n- [ ] Environment variables updated\n- [ ] Feature flags configured\n- [ ] Monitoring alerts set\n\n## Deployment Steps\n1. \n2. \n3. \n\n## Post-Deployment Verification\n- [ ] Health check passing\n- [ ] Key flows tested\n- [ ] Metrics baseline confirmed\n\n## Rollback Procedure\n1. \n2. \n\n## Contacts\n- **On-call:** \n- **Product:** \n', sortOrder: 3 },
  ]).onConflictDoNothing();
  console.log('[seed] Document templates: 20');

  console.log('\n[seed] Development seed complete. ~45 rows seeded.\n');
  process.exit(0);
}

seed().catch((err) => {
  console.error('[seed] Seed failed:', err);
  process.exit(1);
});
