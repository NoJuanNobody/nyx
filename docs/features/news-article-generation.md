# News Article Generation

Generate professionally styled news articles from a topic or research brief using AI. The initial focus is on tabloid-style journalism in the voice of the New York Post.

## Overview

Users can input a topic, headline idea, or background notes and receive a fully drafted news article with proper journalistic structure, sourcing suggestions, and a distinctive tabloid voice. The feature leverages Nyx's existing AI pipeline (Claude API) and optional web search (Tavily) to research and synthesize content before drafting.

## Use Cases

- Journalists and editors who need a fast first draft on a breaking story
- PR and comms teams drafting press-friendly copy with a punchy editorial tone
- Content teams producing high-volume news-style pieces for digital properties
- Nyx users who want to export documentation in a narrative journalistic format

## Publication Styles

The initial release ships with a single style preset:

| Preset | Voice | Structure | Typical Length |
|--------|-------|-----------|---------------|
| `new-york-post` | Punchy, direct, tabloid wit. Short sentences. Bold verbs. | Inverted pyramid. Screaming lede. Subheads every 2–3 paragraphs. Pull quotes. | 400–700 words |

Additional presets (AP wire, longform magazine, BBC online) can be added as follow-on work by extending the `ArticleStyle` type.

## Inputs

| Field | Required | Description |
|-------|----------|-------------|
| `topic` | Yes | Free-text topic, headline idea, or background notes (up to 2000 chars) |
| `style` | No | Publication style preset. Defaults to `new-york-post` |
| `researchEnabled` | No | If `true` and Tavily is configured, run a web search before drafting. Defaults to `false` |
| `additionalContext` | No | Extra facts, quotes, or data the model must incorporate |

## Output

```json
{
  "headline": "CITY IN CHAOS: Mayor's Big Gamble Could Cost Taxpayers Billions",
  "subheadline": "Budget plan blasted as 'reckless' by watchdog groups",
  "body": "...",
  "suggestedPullQuote": "...",
  "wordCount": 512,
  "style": "new-york-post",
  "researchSources": ["...", "..."]
}
```

## Style Guide: New York Post Voice

The system prompt for this style enforces:

1. **Lede** — Lead with the most dramatic or surprising fact. One to two short sentences. No scene-setting.
2. **Inverted pyramid** — Most important information first; background last.
3. **Sentence length** — Average 12 words. Never exceed 25.
4. **Verbs** — Strong, active, specific. "Slammed," "vowed," "blasted" over "said."
5. **Subheadings** — Every 2–3 paragraphs. Punchy, imperative, or interrogative.
6. **Pull quotes** — One per article, the most quotable line from the body.
7. **Attribution** — Every claim is attributed ("sources said," "records show," "officials confirmed").
8. **Tone** — Outrage-adjacent but grounded in fact. No editorializing outside quotes.
9. **Avoid** — Passive voice, jargon, long subordinate clauses, academic hedging.

## Research Mode

When `researchEnabled: true`:

1. Nyx calls the Tavily search API with the user-supplied topic (3 results, `search_depth: "advanced"`).
2. Snippets are injected into the Claude prompt as a `<research>` block.
3. The model is instructed to cite sources as "according to [outlet]" inline.
4. Source URLs are returned in `researchSources[]`.

If `TAVILY_API_KEY` is not configured the endpoint returns a `501 Not Implemented` with a clear error rather than silently proceeding without research.

## API Endpoint

```
POST /api/content/news-article
```

### Request

```json
{
  "topic": "NYC mayor announces $4B stadium deal with no public vote",
  "style": "new-york-post",
  "researchEnabled": true,
  "additionalContext": "Deal was announced Friday evening. Critics include Citizens Budget Commission."
}
```

### Response

```json
{
  "headline": "STADIUM SHOCK: Mayor Bypasses Voters on $4B Deal",
  "subheadline": "Budget watchdog calls no-bid move 'an insult to taxpayers'",
  "body": "Mayor Eric Adams dropped a $4 billion bombshell Friday...",
  "suggestedPullQuote": "'This is an insult to every New Yorker who pays their taxes,' the Citizens Budget Commission said.",
  "wordCount": 487,
  "style": "new-york-post",
  "researchSources": [
    "https://www.nytimes.com/...",
    "https://nypost.com/..."
  ]
}
```

### Error Responses

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `MISSING_TOPIC` | `topic` field is absent or empty |
| 400 | `TOPIC_TOO_LONG` | `topic` exceeds 2000 characters |
| 400 | `UNKNOWN_STYLE` | Unrecognized `style` preset |
| 501 | `RESEARCH_UNAVAILABLE` | `researchEnabled: true` but `TAVILY_API_KEY` not set |
| 500 | `AI_ERROR` | Claude API call failed |

## Frontend (Phase 2)

A "News Article" tab in the Nyx document editor surface will allow:
- Topic input with character count
- Style picker (dropdown, extensible)
- Research toggle (disabled if Tavily key absent)
- Live preview with headline, subheadline, and body in a styled card
- One-click export to Markdown or copy to clipboard

This is a Phase 2 addition. The REST API ships in Phase 1.

## Relationship to Existing Features

| Feature | Relationship |
|---------|-------------|
| `generateDocument()` | Sibling pattern — same Claude service, different prompt + schema |
| Podcast generation | Parallel content-format feature; shares the `POST /api/content/` namespace |
| Social publishing | Output can be cross-posted after generation |
| MCP server | A `nyx_generate_news_article` tool can expose this to Cursor / Claude Code agents |
