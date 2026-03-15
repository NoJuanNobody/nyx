/**
 * Production / Staging seed script — lifecycle document templates only.
 *
 * Safe to run in any environment (production, staging, development).
 * Uses ON CONFLICT DO NOTHING so it is fully idempotent — re-running
 * will never duplicate or overwrite existing templates.
 *
 * Usage:
 *   DATABASE_URL=<url> pnpm --filter @nyx/api db:seed-templates
 */
import 'dotenv/config';
import { isNull } from 'drizzle-orm';
import { db } from './index.js';
import { documentTemplates } from './schema.js';

const TEMPLATES: {
  stage: 'conception' | 'definition' | 'architecture' | 'implementation' | 'execution';
  name: string;
  description: string;
  content: string;
  sortOrder: number;
}[] = [
  // ── Conception ─────────────────────────────────────────────
  { stage: 'conception', name: 'Problem Statement', description: 'Define the problem you are solving and for whom', content: '# Problem Statement\n\n## The Problem\n<!-- What specific problem are you solving? Who experiences it? -->\n\n## Current Solutions\n<!-- How do people solve this today? What\'s broken about existing approaches? -->\n\n## Target Users\n<!-- Who are the primary users? What are their characteristics? -->\n\n## Impact\n<!-- What happens if this problem remains unsolved? What\'s the cost? -->\n\n## Proposed Direction\n<!-- High-level idea for a solution (not detailed spec — just direction) -->\n', sortOrder: 0 },
  { stage: 'conception', name: 'Value Proposition Canvas', description: 'Map customer jobs, pains, and gains against your value map', content: '# Value Proposition Canvas\n\n## Customer Profile\n\n### Jobs to Be Done\n- \n\n### Pains\n- \n\n### Gains\n- \n\n## Value Map\n\n### Products & Services\n- \n\n### Pain Relievers\n- \n\n### Gain Creators\n- \n', sortOrder: 1 },
  { stage: 'conception', name: 'Market Analysis', description: 'Analyze market size, competition, and trends', content: '# Market Analysis\n\n## Market Size\n<!-- TAM, SAM, SOM estimates -->\n\n## Competitive Landscape\n| Competitor | Strengths | Weaknesses | Differentiator |\n|-----------|-----------|------------|----------------|\n|           |           |            |                |\n\n## Trends\n<!-- What market trends support this direction? -->\n\n## Risks\n<!-- What could prevent market adoption? -->\n', sortOrder: 2 },
  { stage: 'conception', name: 'Rough Notes', description: 'Capture unstructured ideas and brain dumps', content: '# Rough Notes\n\n## Key Ideas\n- \n\n## Open Questions\n- \n\n## References\n- \n\n## Next Steps\n- \n', sortOrder: 3 },

  // ── Definition ─────────────────────────────────────────────
  { stage: 'definition', name: 'Product Requirements Document (PRD)', description: 'Complete product specification with goals, user stories, and requirements', content: '# Product Requirements Document\n\n## Overview\n<!-- One-paragraph summary of what we\'re building and why -->\n\n## Goals & Success Metrics\n| Goal | Metric | Target |\n|------|--------|--------|\n|      |        |        |\n\n## User Stories\n\n### As a [user type]\n- I want to [action] so that [benefit]\n\n## Functional Requirements\n\n### Must Have (P0)\n- [ ] \n\n### Should Have (P1)\n- [ ] \n\n### Nice to Have (P2)\n- [ ] \n\n## Non-Functional Requirements\n- Performance: \n- Security: \n- Scalability: \n\n## Out of Scope\n- \n\n## Timeline\n| Milestone | Date | Description |\n|-----------|------|-------------|\n|           |      |             |\n', sortOrder: 0 },
  { stage: 'definition', name: 'User Stories & Personas', description: 'Define user personas and map their stories', content: '# User Stories & Personas\n\n## Personas\n\n### Persona 1: [Name]\n- **Role:** \n- **Goals:** \n- **Pain Points:** \n- **Tech Comfort:** \n\n## User Stories\n\n### Epic: [Epic Name]\n| ID | Story | Acceptance Criteria | Priority |\n|----|-------|-------------------|----------|\n|    |       |                   |          |\n', sortOrder: 1 },
  { stage: 'definition', name: 'Feature Specification', description: 'Detailed specification for a single feature', content: '# Feature Specification\n\n## Feature: [Name]\n\n### Summary\n<!-- What does this feature do? -->\n\n### User Flow\n1. \n2. \n3. \n\n### UI/UX Requirements\n<!-- Wireframes, mockups, or detailed descriptions -->\n\n### Business Rules\n- \n\n### Edge Cases\n- \n\n### Dependencies\n- \n', sortOrder: 2 },
  { stage: 'definition', name: 'Competitive Analysis', description: 'Compare your product against competitors', content: '# Competitive Analysis\n\n## Our Product\n<!-- One-line description -->\n\n## Competitors\n\n### [Competitor 1]\n- **What they do well:** \n- **What they miss:** \n- **Pricing:** \n- **Target audience:** \n\n## Feature Comparison\n| Feature | Us | Competitor 1 | Competitor 2 |\n|---------|-----|-------------|-------------|\n|         |     |             |             |\n\n## Our Advantage\n<!-- What makes us different? -->\n', sortOrder: 3 },

  // ── Architecture ───────────────────────────────────────────
  { stage: 'architecture', name: 'Architecture Decision Record (ADR)', description: 'Document a significant architectural decision', content: '# ADR: [Decision Title]\n\n## Status\nProposed | Accepted | Deprecated | Superseded\n\n## Context\n<!-- What is the technical context? What forces are at play? -->\n\n## Decision\n<!-- What is the change that we\'re proposing? -->\n\n## Consequences\n\n### Positive\n- \n\n### Negative\n- \n\n### Risks\n- \n\n## Alternatives Considered\n| Option | Pros | Cons |\n|--------|------|------|\n|        |      |      |\n', sortOrder: 0 },
  { stage: 'architecture', name: 'Data Model Design', description: 'Design database entities, relationships, and indexes', content: '# Data Model Design\n\n## Entities\n\n### [Entity Name]\n| Field | Type | Required | Description |\n|-------|------|----------|-------------|\n|       |      |          |             |\n\n## Relationships\n<!-- Entity relationship descriptions or diagram references -->\n\n## Indexes\n- \n\n## Migration Notes\n- \n', sortOrder: 1 },
  { stage: 'architecture', name: 'API Contract', description: 'Define API endpoints, request/response schemas, and auth', content: '# API Contract\n\n## Base URL\n`https://api.example.com/v1`\n\n## Authentication\n<!-- How do clients authenticate? -->\n\n## Endpoints\n\n### [POST /resource]\n**Description:** \n\n**Request Body:**\n```json\n{}\n```\n\n**Response (201):**\n```json\n{}\n```\n\n**Error Responses:**\n| Status | Description |\n|--------|-------------|\n| 400    |             |\n| 401    |             |\n\n## Rate Limits\n- \n', sortOrder: 2 },
  { stage: 'architecture', name: 'Component Specification', description: 'Specify a system component: interface, state, and behavior', content: '# Component Specification\n\n## Component: [Name]\n\n### Purpose\n<!-- What does this component do? -->\n\n### Interface\n<!-- Props, inputs, events, outputs -->\n\n### Internal State\n<!-- What state does it manage? -->\n\n### Dependencies\n- \n\n### Error Handling\n- \n\n### Performance Considerations\n- \n', sortOrder: 3 },

  // ── Implementation ─────────────────────────────────────────
  { stage: 'implementation', name: 'AI-Ready Implementation Spec', description: 'Implementation spec optimized for AI coding agents', content: '# Implementation Spec: [Feature Name]\n\n## Context\n<!-- Link to PRD section and architecture decisions -->\n\n## Scope\n<!-- Exactly what code changes are needed -->\n\n## Technical Approach\n\n### Step 1: [Description]\n- Files to modify: \n- Changes: \n\n## Acceptance Criteria\n- [ ] \n\n## Test Plan\n- [ ] Unit: \n- [ ] Integration: \n- [ ] E2E: \n\n## Edge Cases\n| Scenario | Expected Behavior |\n|----------|------------------|\n|          |                  |\n\n## Rollback Plan\n<!-- How to revert if something goes wrong -->\n', sortOrder: 0 },
  { stage: 'implementation', name: 'Ticket Breakdown', description: 'Break a feature into actionable development tickets', content: '# Ticket Breakdown: [Feature Name]\n\n## Overview\n<!-- What feature or epic are these tickets for? -->\n\n## Tickets\n\n### Ticket 1: [Title]\n- **Type:** Feature | Bug | Chore\n- **Priority:** P0 | P1 | P2\n- **Estimate:** \n- **Description:** \n- **Acceptance Criteria:**\n  - [ ] \n- **Dependencies:** None\n', sortOrder: 1 },
  { stage: 'implementation', name: 'Test Plan', description: 'Comprehensive test plan with unit, integration, and E2E cases', content: '# Test Plan: [Feature Name]\n\n## Scope\n<!-- What is being tested? -->\n\n## Test Cases\n\n### Unit Tests\n| ID | Description | Input | Expected Output |\n|----|-------------|-------|-----------------|\n|    |             |       |                 |\n\n### Integration Tests\n| ID | Description | Setup | Expected Result |\n|----|-------------|-------|-----------------|\n|    |             |       |                 |\n\n### E2E Tests\n| ID | User Flow | Steps | Expected Result |\n|----|-----------|-------|-----------------|\n|    |           |       |                 |\n\n## Edge Cases\n- \n\n## Performance Benchmarks\n- \n', sortOrder: 2 },
  { stage: 'implementation', name: 'Edge Cases & Error Handling', description: 'Document error scenarios and boundary conditions', content: '# Edge Cases & Error Handling\n\n## Feature: [Name]\n\n## Error Scenarios\n\n### [Scenario 1]\n- **Trigger:** \n- **Expected behavior:** \n- **User message:** \n- **Recovery:** \n\n## Boundary Conditions\n| Input | Min | Max | Invalid |\n|-------|-----|-----|--------|\n|       |     |     |        |\n\n## Concurrency Issues\n- \n\n## Data Integrity\n- \n', sortOrder: 3 },

  // ── Execution ──────────────────────────────────────────────
  { stage: 'execution', name: 'Release Notes', description: 'Document a release with highlights, features, and fixes', content: '# Release Notes — v[X.Y.Z]\n\n**Release Date:** YYYY-MM-DD\n\n## Highlights\n<!-- 1-2 sentence summary of the release -->\n\n## New Features\n- \n\n## Improvements\n- \n\n## Bug Fixes\n- \n\n## Breaking Changes\n- \n\n## Migration Guide\n<!-- Steps for users to upgrade -->\n\n## Known Issues\n- \n', sortOrder: 0 },
  { stage: 'execution', name: 'Changelog', description: 'Running log of all notable changes', content: '# Changelog\n\nAll notable changes to this project are documented here.\n\n## [Unreleased]\n\n### Added\n- \n\n### Changed\n- \n\n### Fixed\n- \n\n### Removed\n- \n', sortOrder: 1 },
  { stage: 'execution', name: 'Drift Report', description: 'Report on spec-code drift with severity and actions', content: '# Drift Report\n\n**Generated:** YYYY-MM-DD\n**Spec Version:** \n**Code Commit:** \n\n## Summary\n<!-- Overall drift status -->\n\n## Drift Items\n\n### [Area 1]\n- **Spec says:** \n- **Code does:** \n- **Severity:** Low | Medium | High\n- **Action:** Update spec | Update code | Investigate\n\n## No Drift\n- [List areas where spec and code are in sync]\n\n## Recommendations\n- \n', sortOrder: 2 },
  { stage: 'execution', name: 'Deployment Notes', description: 'Pre/post deployment checklist and rollback procedure', content: '# Deployment Notes — v[X.Y.Z]\n\n## Pre-Deployment Checklist\n- [ ] Database migrations reviewed\n- [ ] Environment variables updated\n- [ ] Feature flags configured\n- [ ] Monitoring alerts set\n\n## Deployment Steps\n1. \n2. \n3. \n\n## Post-Deployment Verification\n- [ ] Health check passing\n- [ ] Key flows tested\n- [ ] Metrics baseline confirmed\n\n## Rollback Procedure\n1. \n2. \n\n## Contacts\n- **On-call:** \n- **Product:** \n', sortOrder: 3 },
];

/**
 * Ensures all built-in lifecycle templates exist in the database.
 * Checks for existing global templates (teamId IS NULL) first to avoid
 * duplicates — the unique index on (stage, name, teamId) does not
 * deduplicate NULLs in PostgreSQL.
 */
export async function ensureTemplates(): Promise<void> {
  // Check if any global templates already exist
  const existing = await db
    .select({ id: documentTemplates.id })
    .from(documentTemplates)
    .where(isNull(documentTemplates.teamId))
    .limit(1);

  if (existing.length > 0) {
    return; // Templates already seeded
  }

  const result = await db.insert(documentTemplates)
    .values(TEMPLATES)
    .onConflictDoNothing() as unknown as { rowCount: number };

  const inserted = result?.rowCount ?? 0;
  if (inserted > 0) {
    console.log(`[seed-templates] Inserted ${inserted} lifecycle templates`);
  }
}

// ── CLI entry point ─────────────────────────────────────────────────
// Only runs when executed directly (pnpm db:seed-templates)
const isCLI = process.argv[1]?.includes('seed-templates');
if (isCLI) {
  const env = process.env.NODE_ENV || 'development';
  console.log(`[seed-templates] Environment: ${env}`);
  console.log('[seed-templates] Inserting lifecycle document templates (ON CONFLICT DO NOTHING)...\n');

  ensureTemplates()
    .then(() => {
      console.log('[seed-templates] Done. Total templates defined: ' + TEMPLATES.length);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[seed-templates] Failed:', err);
      process.exit(1);
    });
}
