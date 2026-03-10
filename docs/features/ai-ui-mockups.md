# AI UI Mockup Generation

**TODO item:** #45 (P4 — Post-MVP)
**Status:** TODO

## Overview

Generate UI mockups from spec descriptions via AI and auto-attach them to tickets (GitHub Issues, Jira, Confluence). This gives non-technical stakeholders a visual preview of proposed changes before development begins.

## Proposed Flow

1. User writes or updates a spec describing a UI feature
2. User triggers "Generate Mockup" from the editor or ticket view
3. Backend sends spec text to Claude API with a prompt requesting HTML/CSS output
4. Claude returns structured HTML/CSS representing the mockup
5. Puppeteer renders the HTML to a screenshot (PNG)
6. Screenshot is uploaded and attached to the relevant ticket:
   - GitHub Issues: uploaded via Issues API as an image attachment
   - Jira: attached via the Jira attachments REST API
   - Confluence: embedded as an attachment on the linked page

## API Options

| Approach | Pros | Cons |
|----------|------|------|
| **Claude API → HTML/CSS → Puppeteer screenshot** | Full control over styling, deterministic output, uses existing Claude integration | Requires Puppeteer in backend (heavier dependency), HTML quality depends on prompt |
| **OpenAI Images API (DALL-E)** | Purpose-built for image generation | Less precise for UI layouts, additional vendor dependency |
| **Stability AI** | High-quality image generation | Same precision concerns as DALL-E, additional vendor |
| **HTML → screenshot via hosted service** (e.g., ScreenshotOne, URLBox) | No local Puppeteer needed | External dependency, per-request cost |

**Recommended:** Claude API → HTML/CSS → Puppeteer screenshot. Keeps the stack unified on Anthropic and gives full control over the output.

## Integration Points

- **GitHub Issues API:** Upload image via `POST /repos/{owner}/{repo}/issues/{number}/comments` with embedded markdown image
- **Jira Attachments API:** `POST /rest/api/3/issue/{issueKey}/attachments` with multipart file upload
- **Confluence Attachments API:** `POST /wiki/rest/api/content/{pageId}/child/attachment` with multipart file upload

## Required Services & Routes

### New files

- `apps/api/src/services/mockup.service.ts` — Core mockup generation logic:
  - `generateMockupHTML(specText: string): Promise<string>` — Claude API call to produce HTML/CSS
  - `renderToScreenshot(html: string): Promise<Buffer>` — Puppeteer render to PNG
  - `generateAndAttach(specText: string, ticketRef: TicketRef): Promise<MockupResult>` — End-to-end flow
- `apps/api/src/routes/mockups.ts` — REST endpoints:
  - `POST /api/mockups/generate` — Generate mockup from spec text, return image URL
  - `POST /api/mockups/attach` — Generate and attach mockup to a ticket

### Existing file changes

- `apps/api/src/services/github.service.ts` — Add `attachImageToIssue()` method
- `apps/api/src/services/jira.service.ts` — Add `attachFileToIssue()` method (if Jira integration is built by then)

## Open Questions

- **Image hosting:** Store screenshots in S3/R2, or inline as base64 in ticket comments?
- **Caching:** Cache generated mockups per spec version to avoid redundant generation?
- **Style customization:** Allow teams to provide a base CSS theme so mockups match their design system?
- **Iteration:** Should users be able to give feedback on a mockup and regenerate?
- **Multiple mockups:** Generate multiple variants (desktop, mobile, dark mode) per spec?
- **Puppeteer deployment:** Use a hosted browser service (Browserless, etc.) in production instead of local Puppeteer?
