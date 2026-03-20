# Implementation Plan: News Article Generation

Tracks the work required to ship the [News Article Generation feature](../features/news-article-generation.md).

## Scope

Phase 1 — REST API only (no frontend changes).

---

## Task Breakdown

### 1. AI Service — `generateNewsArticle()`

**File:** `apps/api/src/services/ai.service.ts`

Add a new method alongside the existing `generateDocument()` and `generatePodcastScript()` methods.

```ts
export interface NewsArticleInput {
  topic: string;
  style?: ArticleStyle;
  researchEnabled?: boolean;
  additionalContext?: string;
}

export type ArticleStyle = 'new-york-post'; // extend as needed

export interface NewsArticleResult {
  headline: string;
  subheadline: string;
  body: string;
  suggestedPullQuote: string;
  wordCount: number;
  style: ArticleStyle;
  researchSources: string[];
}
```

**Prompt design:**

```
SYSTEM:
You are an experienced New York Post editor and reporter. Your job is to draft punchy,
factually grounded news articles in the classic New York Post tabloid style.

Rules:
- Lead with the single most dramatic or surprising fact. One sentence, max 25 words.
- Use the inverted pyramid structure (most important → background → detail).
- Keep average sentence length under 15 words.
- Use strong, active verbs. Prefer "slammed", "vowed", "blasted" over "said".
- Insert a bold subheading every 2–3 paragraphs.
- Every factual claim must be attributed ("sources said", "records show", etc.).
- Do not editorialize outside of quoted material.
- Target 400–700 words.

Return a JSON object:
{
  "headline": string,        // ALL CAPS tabloid headline, max 12 words
  "subheadline": string,     // Sentence-case, max 20 words
  "body": string,            // Full article body with **subheadings** as bold markdown
  "suggestedPullQuote": string  // Most quotable line from the body
}

USER:
Topic: {topic}
{additionalContext block if present}
{research block if present}
```

**Steps:**
1. If `researchEnabled`, call `webSearchService.search(topic, { maxResults: 3, depth: 'advanced' })` and inject snippets as a `<research>` block in the user message.
2. Call `anthropic.messages.create` with `model: 'claude-sonnet-4-20250514'`, `max_tokens: 2000`.
3. Parse JSON from response (strip code fences, handle parse errors with a default fallback).
4. Compute `wordCount` from `body.split(/\s+/).length`.
5. Return `NewsArticleResult`.

**Error handling:** Follow the existing pattern — catch API errors, log them, and throw a typed `AiServiceError`.

---

### 2. Web Search Abstraction

**File:** `apps/api/src/services/web-search.service.ts` (new, or check if one already exists)

The Tavily integration is currently used by the MCP server. Centralise it into a shared service:

```ts
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchService {
  search(query: string, opts?: { maxResults?: number; depth?: 'basic' | 'advanced' }): Promise<SearchResult[]>;
  isAvailable(): boolean;
}
```

If a `web-search.service.ts` already exists, extend it. Otherwise create a thin wrapper around the Tavily REST API (`https://api.tavily.com/search`) using `fetch` consistent with the rest of the codebase.

---

### 3. Route

**File:** `apps/api/src/routes/content.ts` (new file, or add to `ai.ts`)

Prefer a dedicated `content.ts` to keep the `ai.ts` route file from growing further.

```ts
// POST /api/content/news-article
fastify.post('/content/news-article', {
  schema: {
    body: {
      type: 'object',
      required: ['topic'],
      properties: {
        topic:             { type: 'string', minLength: 1, maxLength: 2000 },
        style:             { type: 'string', enum: ['new-york-post'], default: 'new-york-post' },
        researchEnabled:   { type: 'boolean', default: false },
        additionalContext: { type: 'string', maxLength: 4000 },
      },
    },
  },
}, async (request, reply) => {
  const { topic, style = 'new-york-post', researchEnabled = false, additionalContext } = request.body as NewsArticleInput;

  if (researchEnabled && !webSearchService.isAvailable()) {
    return reply.code(501).send({ error: 'RESEARCH_UNAVAILABLE', message: 'TAVILY_API_KEY is not configured' });
  }

  const result = await aiService.generateNewsArticle({ topic, style, researchEnabled, additionalContext });
  return reply.send(result);
});
```

Register this route in `apps/api/src/app.ts` alongside the existing route registrations.

---

### 4. Config

**File:** `apps/api/src/lib/config.ts`

`TAVILY_API_KEY` may already be present (used by MCP server). Confirm it is exposed in the API config object. If not, add:

```ts
TAVILY_API_KEY: process.env.TAVILY_API_KEY ?? '',
```

---

### 5. Types

**File:** `packages/shared/src/types/` (or wherever shared API types live)

Export `NewsArticleInput`, `ArticleStyle`, and `NewsArticleResult` from the shared package so the frontend (Phase 2) and MCP server can import them without duplication.

---

### 6. MCP Tool (optional, Phase 1.5)

**File:** `packages/mcp-server/src/tools.ts`

Add a `nyx_generate_news_article` tool so Cursor / Claude Code agents can invoke the endpoint:

```ts
{
  name: 'nyx_generate_news_article',
  description: 'Research and draft a news article in a selected publication style (e.g. New York Post).',
  inputSchema: {
    type: 'object',
    required: ['topic'],
    properties: {
      topic:           { type: 'string' },
      style:           { type: 'string', enum: ['new-york-post'] },
      researchEnabled: { type: 'boolean' },
      additionalContext: { type: 'string' },
    },
  },
}
```

Handler calls `POST /api/content/news-article` via the existing Nyx API client.

---

### 7. Tests

**Unit tests** — `apps/api/src/services/__tests__/ai.service.test.ts`

- Mock `anthropic.messages.create` and assert the returned `NewsArticleResult` shape.
- Test JSON parse error fallback.
- Test `researchEnabled: true` path calls `webSearchService.search`.

**E2E tests** — `e2e/news-article.spec.ts`

- `POST /api/content/news-article` with a minimal topic → 200 with expected fields.
- `POST` with missing topic → 400 `MISSING_TOPIC`.
- `POST` with `researchEnabled: true` and no Tavily key → 501 `RESEARCH_UNAVAILABLE`.

---

## Delivery Order

| # | Task | Effort | Notes |
|---|------|--------|-------|
| 1 | `generateNewsArticle()` in `ai.service.ts` | S | Core prompt, JSON parsing, word count |
| 2 | `WebSearchService` wrapper | S | Only if Tavily not already centralised |
| 3 | Route `POST /api/content/news-article` | S | Schema validation + error codes |
| 4 | Config check (`TAVILY_API_KEY`) | XS | One-liner if already present |
| 5 | Shared types export | XS | Prevent duplication before Phase 2 |
| 6 | Unit tests | S | Mock Claude + Tavily |
| 7 | E2E tests | S | Three happy/sad path cases |
| 8 | MCP tool | S | Optional, can ship after Phase 1 |

**Total Phase 1 estimate:** 4–6 hours of implementation + tests.

---

## Out of Scope (Phase 1)

- Frontend UI (editor tab, style picker, live preview) — Phase 2
- Additional publication styles beyond `new-york-post`
- Saving generated articles to the `documents` table
- Streaming response (article body arrives word-by-word) — nice-to-have, not MVP
- Rate limiting per-user on this endpoint

---

## Open Questions

1. **Route file:** Should `POST /api/content/news-article` live in a new `content.ts` route or be appended to `ai.ts`? Recommend `content.ts` given `ai.ts` is already large and podcast is a sibling feature.
2. **Tavily centralisation:** Is there an existing `web-search.service.ts`? If so, reuse it; if not, create one rather than calling Tavily inline in the AI service.
3. **Style registry:** Should styles be a database-configurable list or a hard-coded `enum`? For MVP, hard-coded is fine; a DB registry enables user-defined styles later.
