-- Document Lifecycle Stages
-- Create document_stage enum
DO $$ BEGIN
  CREATE TYPE "document_stage" AS ENUM('conception', 'definition', 'architecture', 'implementation', 'execution');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Add stage column to documents (nullable — existing docs unaffected)
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "stage" "document_stage";

-- Create document_templates table
CREATE TABLE IF NOT EXISTS "document_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stage" "document_stage" NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "content" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Seed built-in templates

-- Conception templates
INSERT INTO "document_templates" ("stage", "name", "description", "content", "sort_order") VALUES
('conception', 'Problem Statement', 'Define the problem you are solving and for whom', E'# Problem Statement\n\n## The Problem\n<!-- What specific problem are you solving? Who experiences it? -->\n\n## Current Solutions\n<!-- How do people solve this today? What''s broken about existing approaches? -->\n\n## Target Users\n<!-- Who are the primary users? What are their characteristics? -->\n\n## Impact\n<!-- What happens if this problem remains unsolved? What''s the cost? -->\n\n## Proposed Direction\n<!-- High-level idea for a solution (not detailed spec — just direction) -->\n', 0),
('conception', 'Value Proposition Canvas', 'Map customer jobs, pains, and gains against your value map', E'# Value Proposition Canvas\n\n## Customer Profile\n\n### Jobs to Be Done\n- \n\n### Pains\n- \n\n### Gains\n- \n\n## Value Map\n\n### Products & Services\n- \n\n### Pain Relievers\n- \n\n### Gain Creators\n- \n', 1),
('conception', 'Market Analysis', 'Analyze market size, competition, and trends', E'# Market Analysis\n\n## Market Size\n<!-- TAM, SAM, SOM estimates -->\n\n## Competitive Landscape\n| Competitor | Strengths | Weaknesses | Differentiator |\n|-----------|-----------|------------|----------------|\n|           |           |            |                |\n\n## Trends\n<!-- What market trends support this direction? -->\n\n## Risks\n<!-- What could prevent market adoption? -->\n', 2),
('conception', 'Rough Notes', 'Capture unstructured ideas and brain dumps', E'# Rough Notes\n\n## Key Ideas\n- \n\n## Open Questions\n- \n\n## References\n- \n\n## Next Steps\n- \n', 3)
ON CONFLICT DO NOTHING;

-- Definition templates
INSERT INTO "document_templates" ("stage", "name", "description", "content", "sort_order") VALUES
('definition', 'Product Requirements Document (PRD)', 'Complete product specification with goals, user stories, and requirements', E'# Product Requirements Document\n\n## Overview\n<!-- One-paragraph summary of what we''re building and why -->\n\n## Goals & Success Metrics\n| Goal | Metric | Target |\n|------|--------|--------|\n|      |        |        |\n\n## User Stories\n\n### As a [user type]\n- I want to [action] so that [benefit]\n\n## Functional Requirements\n\n### Must Have (P0)\n- [ ] \n\n### Should Have (P1)\n- [ ] \n\n### Nice to Have (P2)\n- [ ] \n\n## Non-Functional Requirements\n- Performance: \n- Security: \n- Scalability: \n\n## Out of Scope\n- \n\n## Timeline\n| Milestone | Date | Description |\n|-----------|------|-------------|\n|           |      |             |\n', 0),
('definition', 'User Stories & Personas', 'Define user personas and map their stories', E'# User Stories & Personas\n\n## Personas\n\n### Persona 1: [Name]\n- **Role:** \n- **Goals:** \n- **Pain Points:** \n- **Tech Comfort:** \n\n## User Stories\n\n### Epic: [Epic Name]\n| ID | Story | Acceptance Criteria | Priority |\n|----|-------|-------------------|----------|\n|    |       |                   |          |\n', 1),
('definition', 'Feature Specification', 'Detailed specification for a single feature', E'# Feature Specification\n\n## Feature: [Name]\n\n### Summary\n<!-- What does this feature do? -->\n\n### User Flow\n1. \n2. \n3. \n\n### UI/UX Requirements\n<!-- Wireframes, mockups, or detailed descriptions -->\n\n### Business Rules\n- \n\n### Edge Cases\n- \n\n### Dependencies\n- \n', 2),
('definition', 'Competitive Analysis', 'Compare your product against competitors', E'# Competitive Analysis\n\n## Our Product\n<!-- One-line description -->\n\n## Competitors\n\n### [Competitor 1]\n- **What they do well:** \n- **What they miss:** \n- **Pricing:** \n- **Target audience:** \n\n## Feature Comparison\n| Feature | Us | Competitor 1 | Competitor 2 |\n|---------|-----|-------------|-------------|\n|         |     |             |             |\n\n## Our Advantage\n<!-- What makes us different? -->\n', 3)
ON CONFLICT DO NOTHING;

-- Architecture templates
INSERT INTO "document_templates" ("stage", "name", "description", "content", "sort_order") VALUES
('architecture', 'Architecture Decision Record (ADR)', 'Document a significant architectural decision', E'# ADR: [Decision Title]\n\n## Status\nProposed | Accepted | Deprecated | Superseded\n\n## Context\n<!-- What is the technical context? What forces are at play? -->\n\n## Decision\n<!-- What is the change that we''re proposing? -->\n\n## Consequences\n\n### Positive\n- \n\n### Negative\n- \n\n### Risks\n- \n\n## Alternatives Considered\n| Option | Pros | Cons |\n|--------|------|------|\n|        |      |      |\n', 0),
('architecture', 'Data Model Design', 'Design database entities, relationships, and indexes', E'# Data Model Design\n\n## Entities\n\n### [Entity Name]\n| Field | Type | Required | Description |\n|-------|------|----------|-------------|\n|       |      |          |             |\n\n## Relationships\n<!-- Entity relationship descriptions or diagram references -->\n\n## Indexes\n- \n\n## Migration Notes\n- \n', 1),
('architecture', 'API Contract', 'Define API endpoints, request/response schemas, and auth', E'# API Contract\n\n## Base URL\n`https://api.example.com/v1`\n\n## Authentication\n<!-- How do clients authenticate? -->\n\n## Endpoints\n\n### [POST /resource]\n**Description:** \n\n**Request Body:**\n```json\n{}\n```\n\n**Response (201):**\n```json\n{}\n```\n\n**Error Responses:**\n| Status | Description |\n|--------|-------------|\n| 400    |             |\n| 401    |             |\n\n## Rate Limits\n- \n', 2),
('architecture', 'Component Specification', 'Specify a system component: interface, state, and behavior', E'# Component Specification\n\n## Component: [Name]\n\n### Purpose\n<!-- What does this component do? -->\n\n### Interface\n<!-- Props, inputs, events, outputs -->\n\n### Internal State\n<!-- What state does it manage? -->\n\n### Dependencies\n- \n\n### Error Handling\n- \n\n### Performance Considerations\n- \n', 3)
ON CONFLICT DO NOTHING;

-- Implementation templates
INSERT INTO "document_templates" ("stage", "name", "description", "content", "sort_order") VALUES
('implementation', 'AI-Ready Implementation Spec', 'Implementation spec optimized for AI coding agents', E'# Implementation Spec: [Feature Name]\n\n## Context\n<!-- Link to PRD section and architecture decisions -->\n\n## Scope\n<!-- Exactly what code changes are needed -->\n\n## Technical Approach\n\n### Step 1: [Description]\n- Files to modify: \n- Changes: \n\n## Acceptance Criteria\n- [ ] \n\n## Test Plan\n- [ ] Unit: \n- [ ] Integration: \n- [ ] E2E: \n\n## Edge Cases\n| Scenario | Expected Behavior |\n|----------|------------------|\n|          |                  |\n\n## Rollback Plan\n<!-- How to revert if something goes wrong -->\n', 0),
('implementation', 'Ticket Breakdown', 'Break a feature into actionable development tickets', E'# Ticket Breakdown: [Feature Name]\n\n## Overview\n<!-- What feature or epic are these tickets for? -->\n\n## Tickets\n\n### Ticket 1: [Title]\n- **Type:** Feature | Bug | Chore\n- **Priority:** P0 | P1 | P2\n- **Estimate:** \n- **Description:** \n- **Acceptance Criteria:**\n  - [ ] \n- **Dependencies:** None\n', 1),
('implementation', 'Test Plan', 'Comprehensive test plan with unit, integration, and E2E cases', E'# Test Plan: [Feature Name]\n\n## Scope\n<!-- What is being tested? -->\n\n## Test Cases\n\n### Unit Tests\n| ID | Description | Input | Expected Output |\n|----|-------------|-------|-----------------|\n|    |             |       |                 |\n\n### Integration Tests\n| ID | Description | Setup | Expected Result |\n|----|-------------|-------|-----------------|\n|    |             |       |                 |\n\n### E2E Tests\n| ID | User Flow | Steps | Expected Result |\n|----|-----------|-------|-----------------|\n|    |           |       |                 |\n\n## Edge Cases\n- \n\n## Performance Benchmarks\n- \n', 2),
('implementation', 'Edge Cases & Error Handling', 'Document error scenarios and boundary conditions', E'# Edge Cases & Error Handling\n\n## Feature: [Name]\n\n## Error Scenarios\n\n### [Scenario 1]\n- **Trigger:** \n- **Expected behavior:** \n- **User message:** \n- **Recovery:** \n\n## Boundary Conditions\n| Input | Min | Max | Invalid |\n|-------|-----|-----|--------|\n|       |     |     |        |\n\n## Concurrency Issues\n- \n\n## Data Integrity\n- \n', 3)
ON CONFLICT DO NOTHING;

-- Execution templates
INSERT INTO "document_templates" ("stage", "name", "description", "content", "sort_order") VALUES
('execution', 'Release Notes', 'Document a release with highlights, features, and fixes', E'# Release Notes — v[X.Y.Z]\n\n**Release Date:** YYYY-MM-DD\n\n## Highlights\n<!-- 1-2 sentence summary of the release -->\n\n## New Features\n- \n\n## Improvements\n- \n\n## Bug Fixes\n- \n\n## Breaking Changes\n- \n\n## Migration Guide\n<!-- Steps for users to upgrade -->\n\n## Known Issues\n- \n', 0),
('execution', 'Changelog', 'Running log of all notable changes', E'# Changelog\n\nAll notable changes to this project are documented here.\n\n## [Unreleased]\n\n### Added\n- \n\n### Changed\n- \n\n### Fixed\n- \n\n### Removed\n- \n', 1),
('execution', 'Drift Report', 'Report on spec-code drift with severity and actions', E'# Drift Report\n\n**Generated:** YYYY-MM-DD\n**Spec Version:** \n**Code Commit:** \n\n## Summary\n<!-- Overall drift status -->\n\n## Drift Items\n\n### [Area 1]\n- **Spec says:** \n- **Code does:** \n- **Severity:** Low | Medium | High\n- **Action:** Update spec | Update code | Investigate\n\n## No Drift\n- [List areas where spec and code are in sync]\n\n## Recommendations\n- \n', 2),
('execution', 'Deployment Notes', 'Pre/post deployment checklist and rollback procedure', E'# Deployment Notes — v[X.Y.Z]\n\n## Pre-Deployment Checklist\n- [ ] Database migrations reviewed\n- [ ] Environment variables updated\n- [ ] Feature flags configured\n- [ ] Monitoring alerts set\n\n## Deployment Steps\n1. \n2. \n3. \n\n## Post-Deployment Verification\n- [ ] Health check passing\n- [ ] Key flows tested\n- [ ] Metrics baseline confirmed\n\n## Rollback Procedure\n1. \n2. \n\n## Contacts\n- **On-call:** \n- **Product:** \n', 3)
ON CONFLICT DO NOTHING;

-- Create index on document_templates.stage for filtering
CREATE INDEX IF NOT EXISTS "idx_document_templates_stage" ON "document_templates" ("stage");

-- Create index on documents.stage for filtering
CREATE INDEX IF NOT EXISTS "idx_documents_stage" ON "documents" ("stage");
