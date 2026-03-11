# AI UI Mockup Generation

**TODO item:** #45 (P4 — Post-MVP)
**Status:** TODO

## Overview

Generate UI mockups from spec descriptions via AI and auto-attach them to tickets (GitHub Issues, Jira). This gives non-technical stakeholders a visual preview of proposed changes before development begins.

> **Note:** Confluence attachment is out of scope for this feature. The Confluence integration (#33) is pull-only (importing docs from Confluence into SyncDocs) and does not support writing attachments back to Confluence pages. See [docs/features/confluence-integration.md](./confluence-integration.md) for details.

## Proposed Flow

1. User writes or updates a spec describing a UI feature
2. User triggers "Generate Mockup" from the editor or ticket view
3. Backend sends spec text to Claude API with a prompt requesting HTML/CSS output
4. Claude returns structured HTML/CSS representing the mockup
5. Puppeteer renders the HTML to a screenshot (PNG)
6. Screenshot is uploaded and attached to the relevant ticket:
   - GitHub Issues: uploaded via Issues API as an image attachment
   - Jira: attached via the Jira attachments REST API

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

---

## E2E Tests

**Test file:** `tests/e2e/ai-ui-mockups.spec.ts`

### Mockup generation

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 1 | Generate mockup from editor | Open document with UI spec content → click "Generate Mockup" button | Loading state → `POST /api/mockups/generate` called with spec text → PNG image returned and displayed in UI |
| 2 | Generate mockup from ticket view | Navigate to ticket detail → click "Generate Mockup" | Mockup generated from ticket description; preview displayed |
| 3 | Generated mockup is valid PNG | Generate mockup → inspect response | Response contains valid PNG image data; image renders without errors |
| 4 | Mockup reflects spec content | Write spec describing "login form with email and password fields" → generate | Generated mockup visually contains email field, password field, and submit button (verify via visible elements in preview) |

### Attach to GitHub Issues

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 5 | Attach mockup to GitHub issue | Generate mockup → click "Attach to ticket" → select a GitHub issue | `POST /api/mockups/attach` called → image uploaded → GitHub issue comment created with embedded markdown image |
| 6 | Verify attachment on GitHub | Attach mockup → navigate to the GitHub issue (or verify via API) | Issue has new comment with rendered mockup image |
| 7 | Attach fails gracefully without GitHub integration | No GitHub integration configured → attempt attach | Error toast: "GitHub integration not configured"; no crash |

### Attach to Jira

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 8 | Attach mockup to Jira ticket | Generate mockup → click "Attach to ticket" → select a Jira issue | Image uploaded via Jira attachments API; attachment visible on issue |
| 9 | Jira attachment includes metadata | Attach mockup → check Jira issue attachments | Attachment has descriptive filename (e.g., `mockup-{docTitle}-{timestamp}.png`) |

### Attach to Confluence

> **Out of scope.** Confluence attachment is not part of this feature. The Confluence integration (#33) is pull-only and does not support writing back to Confluence. Mockup attachment to Confluence pages would be addressed as part of the Confluence integration if push support is added in a future iteration.

### API endpoints

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 11 | POST /api/mockups/generate returns image | Send `{ specText: "A user profile page with avatar and bio" }` to endpoint | 200 response with `{ imageUrl: "..." }` pointing to generated PNG |
| 12 | POST /api/mockups/attach end-to-end | Send `{ specText: "...", ticketRef: { provider: "github", owner: "...", repo: "...", issueNumber: 1 } }` | 200 response; mockup generated and attached to specified ticket |
| 13 | Invalid spec text returns error | Send `{ specText: "" }` to generate endpoint | 400 response with validation error |
| 14 | Missing ticket ref returns error | Send generate request without `ticketRef` to attach endpoint | 400 response with validation error |

### Error handling

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 15 | AI generation failure | Mock Claude API to return error → trigger generate | Error message displayed: "Failed to generate mockup"; user can retry |
| 16 | Puppeteer render failure | Mock Puppeteer to throw → trigger generate | Error message displayed: "Failed to render screenshot"; no partial state |
| 17 | GitHub API upload failure | Mock GitHub API to return 403 → trigger attach | Error toast: "Failed to attach to GitHub issue"; mockup still viewable locally |
| 18 | Jira API upload failure | Mock Jira API to return 401 → trigger attach | Error toast: "Failed to attach to Jira ticket — check integration credentials" |

### Auth & permissions

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 19 | Editor+ can generate mockups | Log in as editor → generate mockup | Mockup generated successfully |
| 20 | Viewer cannot generate mockups | Log in as viewer → "Generate Mockup" button | Button disabled or hidden; API returns 403 if called directly |
| 21 | Requires valid integration for attach | Attempt attach to provider with no active integration | Error message indicating missing integration; prompt to configure in Settings |
