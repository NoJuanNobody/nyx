# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SyncDocs is a product versioning platform that unifies technical documentation, code, and team workflow. It keeps specs in sync with code as it evolves and lets non-technical stakeholders initiate changes that flow through to the codebase.

The product brief is at `SyncDocs_ProductBrief.md` — read it for full context on features, target users, competitive landscape, and business model.

## Project Status

Pre-MVP / scaffolding phase. No code has been written yet. The next step is to scaffold the project using the product brief as the starting spec.

## Planned Tech Stack

- **Frontend:** React + TypeScript, hosted on Vercel
- **Backend:** Node.js + Express or Fastify, hosted on Railway or Render
- **Database:** PostgreSQL (document storage, version history)
- **AI:** Anthropic Claude API (spec quality analysis, drift detection, ticket generation)
- **Auth:** Auth0 or Clerk
- **Integrations:** GitHub API + Webhooks, Jira REST API, Confluence REST API
- **Agent Integrations:** Cursor extension, GitHub Copilot extension, Claude Code MCP/CLI

## MVP Core Features

1. Structured document editor with markdown support and AI-assisted spec writing
2. GitHub integration that detects doc-code drift
3. Ticket creation via GitHub Issues or Jira integration (not internal ticketing)
4. Document version history with diff view
5. Role-based team access (dev vs. non-dev)
6. Onboarding flow that scans existing codebases to bootstrap documentation
7. Documentation export (Markdown, PDF)

## Architecture Principles

- SyncDocs integrates with external tools (GitHub Issues, Jira, Confluence) rather than replacing them
- Coding agent integrations (Cursor, Copilot, Claude Code) are first-class — specs should flow directly into AI coding workflows
- Non-technical users initiate changes through documentation; those changes are pushed as tickets to developer tools
- No vendor lock-in — full documentation export is always available
