# Document Lifecycle Stages

## Overview

Nyx documents progress through 5 lifecycle stages. Stages are **optional** (nullable) — they guide workflow but never block it. Users can skip stages, ignore them, or assign them later.

---

## The 5 Stages

### 1. Conception (CO)
- **Color:** Gold (#F59E0B)
- **Who:** Product Managers, Founders, Stakeholders
- **Purpose:** Capture the initial idea, problem space, and vision
- **Document Types:**
  - Problem Statement
  - Value Proposition Canvas
  - Market Analysis
  - Rough Notes / Brain Dump
- **AI Quality Criteria:** Clarity of problem definition, market validation evidence, target user identification, uniqueness of approach
- **Output:** Validated idea ready for detailed specification

### 2. Definition (DF)
- **Color:** Teal (#14B8A6)
- **Who:** Product Managers, Designers
- **Purpose:** Translate the idea into a complete product specification
- **Document Types:**
  - Product Requirements Document (PRD)
  - User Stories & Personas
  - Feature Specification
  - Competitive Analysis
- **AI Quality Criteria:** Completeness of requirements, unambiguous language, user story coverage, acceptance criteria presence, measurable success metrics
- **Output:** Complete PRD ready for architecture planning

### 3. Architecture (AR)
- **Color:** Indigo (#6366F1)
- **Who:** Tech Leads, Senior Engineers
- **Purpose:** Design the system that implements the specification
- **Document Types:**
  - Architecture Decision Record (ADR)
  - Data Model Design
  - API Contract
  - Component Specification
- **AI Quality Criteria:** Technical feasibility, traceability to PRD, scalability considerations, security review, dependency analysis
- **Output:** Technical blueprint ready for implementation

### 4. Implementation (IM)
- **Color:** Violet (#8B5CF6)
- **Who:** Engineers, QA
- **Purpose:** Create developer-ready specifications that AI coding agents can consume
- **Document Types:**
  - AI-Ready Implementation Spec
  - Ticket Breakdown
  - Test Plan
  - Edge Cases & Error Handling
- **AI Quality Criteria:** AI-readiness score, acceptance criteria clarity, testability, edge case coverage, ticket granularity
- **Output:** Actionable tickets and specs for development

### 5. Execution (EX)
- **Color:** Emerald (#10B981)
- **Who:** Engineers, DevOps, Release Managers
- **Purpose:** Track the living codebase and keep documentation in sync with shipped code
- **Document Types:**
  - Release Notes
  - Changelog
  - Drift Report
  - Deployment Notes
- **AI Quality Criteria:** Freshness (last updated vs last deploy), drift coverage, release completeness, accuracy against current codebase
- **Output:** Up-to-date documentation that reflects the actual system

---

## Templates

Each document type has a markdown template that pre-populates structure.

### Conception Templates

**Problem Statement**
```markdown
# Problem Statement

## The Problem
<!-- What specific problem are you solving? Who experiences it? -->

## Current Solutions
<!-- How do people solve this today? What's broken about existing approaches? -->

## Target Users
<!-- Who are the primary users? What are their characteristics? -->

## Impact
<!-- What happens if this problem remains unsolved? What's the cost? -->

## Proposed Direction
<!-- High-level idea for a solution (not detailed spec — just direction) -->
```

**Value Proposition Canvas**
```markdown
# Value Proposition Canvas

## Customer Profile

### Jobs to Be Done
-

### Pains
-

### Gains
-

## Value Map

### Products & Services
-

### Pain Relievers
-

### Gain Creators
-
```

**Market Analysis**
```markdown
# Market Analysis

## Market Size
<!-- TAM, SAM, SOM estimates -->

## Competitive Landscape
| Competitor | Strengths | Weaknesses | Differentiator |
|-----------|-----------|------------|----------------|
|           |           |            |                |

## Trends
<!-- What market trends support this direction? -->

## Risks
<!-- What could prevent market adoption? -->
```

**Rough Notes**
```markdown
# Rough Notes

## Key Ideas
-

## Open Questions
-

## References
-

## Next Steps
-
```

### Definition Templates

**Product Requirements Document (PRD)**
```markdown
# Product Requirements Document

## Overview
<!-- One-paragraph summary of what we're building and why -->

## Goals & Success Metrics
| Goal | Metric | Target |
|------|--------|--------|
|      |        |        |

## User Stories

### As a [user type]
- I want to [action] so that [benefit]

## Functional Requirements

### Must Have (P0)
- [ ]

### Should Have (P1)
- [ ]

### Nice to Have (P2)
- [ ]

## Non-Functional Requirements
- Performance:
- Security:
- Scalability:

## Out of Scope
-

## Timeline
| Milestone | Date | Description |
|-----------|------|-------------|
|           |      |             |
```

**User Stories & Personas**
```markdown
# User Stories & Personas

## Personas

### Persona 1: [Name]
- **Role:**
- **Goals:**
- **Pain Points:**
- **Tech Comfort:**

## User Stories

### Epic: [Epic Name]
| ID | Story | Acceptance Criteria | Priority |
|----|-------|-------------------|----------|
|    |       |                   |          |
```

**Feature Specification**
```markdown
# Feature Specification

## Feature: [Name]

### Summary
<!-- What does this feature do? -->

### User Flow
1.
2.
3.

### UI/UX Requirements
<!-- Wireframes, mockups, or detailed descriptions -->

### Business Rules
-

### Edge Cases
-

### Dependencies
-
```

**Competitive Analysis**
```markdown
# Competitive Analysis

## Our Product
<!-- One-line description -->

## Competitors

### [Competitor 1]
- **What they do well:**
- **What they miss:**
- **Pricing:**
- **Target audience:**

## Feature Comparison
| Feature | Us | Competitor 1 | Competitor 2 |
|---------|-----|-------------|-------------|
|         |     |             |             |

## Our Advantage
<!-- What makes us different? -->
```

### Architecture Templates

**Architecture Decision Record (ADR)**
```markdown
# ADR: [Decision Title]

## Status
Proposed | Accepted | Deprecated | Superseded

## Context
<!-- What is the technical context? What forces are at play? -->

## Decision
<!-- What is the change that we're proposing? -->

## Consequences

### Positive
-

### Negative
-

### Risks
-

## Alternatives Considered
| Option | Pros | Cons |
|--------|------|------|
|        |      |      |
```

**Data Model Design**
```markdown
# Data Model Design

## Entities

### [Entity Name]
| Field | Type | Required | Description |
|-------|------|----------|-------------|
|       |      |          |             |

## Relationships
<!-- Entity relationship descriptions or diagram references -->

## Indexes
-

## Migration Notes
-
```

**API Contract**
````markdown
# API Contract

## Base URL
`https://api.example.com/v1`

## Authentication
<!-- How do clients authenticate? -->

## Endpoints

### [POST /resource]
**Description:**

**Request Body:**
```json
{}
```

**Response (201):**
```json
{}
```

**Error Responses:**
| Status | Description |
|--------|-------------|
| 400    |             |
| 401    |             |

## Rate Limits
-
````

**Component Specification**
```markdown
# Component Specification

## Component: [Name]

### Purpose
<!-- What does this component do? -->

### Interface
<!-- Props, inputs, events, outputs -->

### Internal State
<!-- What state does it manage? -->

### Dependencies
-

### Error Handling
-

### Performance Considerations
-
```

### Implementation Templates

**AI-Ready Implementation Spec**
```markdown
# Implementation Spec: [Feature Name]

## Context
<!-- Link to PRD section and architecture decisions -->

## Scope
<!-- Exactly what code changes are needed -->

## Technical Approach
<!-- Step-by-step implementation plan -->

### Step 1: [Description]
- Files to modify:
- Changes:

## Acceptance Criteria
- [ ]

## Test Plan
- [ ] Unit:
- [ ] Integration:
- [ ] E2E:

## Edge Cases
| Scenario | Expected Behavior |
|----------|------------------|
|          |                  |

## Rollback Plan
<!-- How to revert if something goes wrong -->
```

**Ticket Breakdown**
```markdown
# Ticket Breakdown: [Feature Name]

## Overview
<!-- What feature or epic are these tickets for? -->

## Tickets

### Ticket 1: [Title]
- **Type:** Feature | Bug | Chore
- **Priority:** P0 | P1 | P2
- **Estimate:**
- **Description:**
- **Acceptance Criteria:**
  - [ ]
- **Dependencies:** None

### Ticket 2: [Title]
- **Type:**
- **Priority:**
- **Estimate:**
- **Description:**
- **Acceptance Criteria:**
  - [ ]
- **Dependencies:** Ticket 1
```

**Test Plan**
```markdown
# Test Plan: [Feature Name]

## Scope
<!-- What is being tested? -->

## Test Cases

### Unit Tests
| ID | Description | Input | Expected Output |
|----|-------------|-------|----------------|
|    |             |       |                |

### Integration Tests
| ID | Description | Setup | Expected Result |
|----|-------------|-------|----------------|
|    |             |       |                |

### E2E Tests
| ID | User Flow | Steps | Expected Result |
|----|-----------|-------|----------------|
|    |           |       |                |

## Edge Cases
-

## Performance Benchmarks
-
```

**Edge Cases & Error Handling**
```markdown
# Edge Cases & Error Handling

## Feature: [Name]

## Error Scenarios

### [Scenario 1]
- **Trigger:**
- **Expected behavior:**
- **User message:**
- **Recovery:**

## Boundary Conditions
| Input | Min | Max | Invalid |
|-------|-----|-----|---------|
|       |     |     |         |

## Concurrency Issues
-

## Data Integrity
-
```

### Execution Templates

**Release Notes**
```markdown
# Release Notes — v[X.Y.Z]

**Release Date:** YYYY-MM-DD

## Highlights
<!-- 1-2 sentence summary of the release -->

## New Features
-

## Improvements
-

## Bug Fixes
-

## Breaking Changes
-

## Migration Guide
<!-- Steps for users to upgrade -->

## Known Issues
-
```

**Changelog**
```markdown
# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added
-

### Changed
-

### Fixed
-

### Removed
-
```

**Drift Report**
```markdown
# Drift Report

**Generated:** YYYY-MM-DD
**Spec Version:**
**Code Commit:**

## Summary
<!-- Overall drift status -->

## Drift Items

### [Area 1]
- **Spec says:**
- **Code does:**
- **Severity:** Low | Medium | High
- **Action:** Update spec | Update code | Investigate

## No Drift
- [List areas where spec and code are in sync]

## Recommendations
-
```

**Deployment Notes**
```markdown
# Deployment Notes — v[X.Y.Z]

## Pre-Deployment Checklist
- [ ] Database migrations reviewed
- [ ] Environment variables updated
- [ ] Feature flags configured
- [ ] Monitoring alerts set

## Deployment Steps
1.
2.
3.

## Post-Deployment Verification
- [ ] Health check passing
- [ ] Key flows tested
- [ ] Metrics baseline confirmed

## Rollback Procedure
1.
2.

## Contacts
- **On-call:**
- **Product:**
```

---

## Stage Transitions & Seeding

When a user clicks "Seed next stage" on a document:

1. The system determines the next stage (Conception -> Definition -> Architecture -> Implementation -> Execution)
2. AI generates initial content for the next stage based on the source document
3. A new document is created with:
   - Stage set to the target stage
   - Content generated by AI with `<!-- Seeded from: {sourceDocId} -->` in front-matter
   - Title derived from the source document
4. Timeline events are created on both source and target documents

### Seeding Prompts by Transition

| From | To | AI Task |
|------|-----|---------|
| Conception | Definition | Extract requirements, user stories, and success metrics from the problem/vision doc |
| Definition | Architecture | Design system architecture, data models, and API contracts from the PRD |
| Architecture | Implementation | Create implementation specs, ticket breakdowns, and test plans from architecture |
| Implementation | Execution | Generate release notes template, deployment checklist from implementation specs |

---

## AI Quality Criteria by Stage

### Stage-Aware System Prompts

The AI quality analyzer uses different criteria depending on the document's stage:

- **Conception:** Is the problem clearly defined? Is there evidence of market validation? Are target users identified? Is the approach unique?
- **Definition:** Are requirements complete and unambiguous? Do user stories have acceptance criteria? Are success metrics measurable? Is scope clearly bounded?
- **Architecture:** Is the design technically feasible? Does it trace back to PRD requirements? Are scalability and security addressed? Are trade-offs documented?
- **Implementation:** Can an AI coding agent act on this spec? Are acceptance criteria testable? Are edge cases covered? Is the ticket breakdown granular enough?
- **Execution:** Is the documentation current? Does it match the deployed code? Are all changes since last release documented? Is the drift score low?
- **No stage (null):** Use the existing generic quality analysis
