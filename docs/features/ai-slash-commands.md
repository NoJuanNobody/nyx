# AI Slash Commands

**Issue:** [#48 — Ai slash commands](https://github.com/NoJuanNobody/nyx/issues/48)
**Status:** Planned
**Stage:** Definition

---

## Overview

AI slash commands bring template-based document creation directly into the editor. When a user types `/` at the start of a line in any document, a floating command palette appears listing all available document templates. Selecting one inserts the template skeleton into the current document and immediately triggers an AI pass to flesh out the placeholder sections based on document context (title, stage, existing content, linked repository).

This removes the friction of the current modal-based template picker and makes template-driven authoring feel as natural as typing.

---

## User Stories

- **As a product manager**, I want to type `/prd` and have Nyx generate a filled-out Product Requirements Document so I can start reviewing instead of writing from scratch.
- **As a developer**, I want to type `/api-spec` inside an architecture doc and have the AI populate endpoint tables and data models based on context.
- **As any team member**, I want fuzzy search within the slash command palette so I can find the right template without memorising exact names.
- **As a team admin**, I want custom team templates to appear in the slash command palette alongside built-in ones.

---

## Feature Details

### Trigger & Invocation

- Typing `/` at the **beginning of a new line** (or with only whitespace before it on that line) opens the command palette.
- Typing continues to filter the list: `/prd` narrows to templates whose name or description matches "prd".
- `Escape` dismisses the palette and removes the `/` from the document.
- `↑` / `↓` navigate the list; `Enter` or click selects.

### Command Palette UI

A small floating card appears just below the cursor line, anchored to the caret position in the editor. It shows:

```
┌─────────────────────────────────────────┐
│  /prd                                   │
├─────────────────────────────────────────┤
│  ● PRD             [DEF]  Product Req…  │
│  ● PRD Lite        [DEF]  Lightweight…  │
│  ─────────────────────────────────────  │
│  ● Custom PRD      [CON]  Your team's…  │
└─────────────────────────────────────────┘
```

- Stage badge (DEF, ARC, etc.) shown on each entry.
- Section dividers separate built-in from custom templates.
- Maximum 8 items visible; scrollable.

### Template Insertion & AI Enrichment

When a template is selected:

1. The `/query` text on the current line is replaced with the template's markdown skeleton.
2. A loading indicator appears in the gutter (or as a subtle overlay on affected sections).
3. A call is made to `POST /api/ai/enrich-template` (new endpoint) with:
   - `templateId` — the selected template
   - `documentTitle` — current document title
   - `documentStage` — current document stage
   - `existingContent` — everything in the document before/after the inserted block (for context)
   - `repositoryId` — linked repo if any
4. The AI response streams in section by section, replacing `{{placeholder}}` tokens in the skeleton with generated content.
5. When streaming completes, the enriched content is committed to the editor's `onChange` handler and the document auto-saves normally.

### Slash Commands Beyond Templates

The palette also supports a small set of inline formatting commands that do not call the AI:

| Command      | Action                                      |
|-------------|---------------------------------------------|
| `/h1`        | Insert `# ` heading at cursor               |
| `/h2`        | Insert `## ` heading                        |
| `/table`     | Insert a markdown table skeleton            |
| `/callout`   | Insert a `> **Note:**` callout block        |
| `/divider`   | Insert `---`                                |
| `/toc`       | Insert a `[[TOC]]` placeholder              |

These execute instantly with no AI call.

### Error & Edge Cases

- If the AI enrichment fails, the template skeleton remains in the document with placeholders intact and a toast notifies the user ("AI enrichment failed — template inserted as-is. Retry?").
- If the user edits the template before enrichment completes, the stream is cancelled and the partial AI content is discarded; the user's edits are preserved.
- The palette is not triggered inside code fences or when the `/` is mid-word (e.g., URLs).

---

## Out of Scope (v1)

- Slash commands that create *new documents* (the issue proposes this, but inline enrichment is lower friction and more immediately useful).
- Slash commands in the AI chat panel.
- Custom slash command aliases (e.g., mapping `/myprd` to a specific template) — deferred to v2.
- Voice / dictation trigger.

---

## Success Metrics

- ≥ 40% of new documents created via slash command within 30 days of launch.
- Template → published doc conversion rate increases (fewer abandoned blank templates).
- Time-to-first-content on a new document decreases by ≥ 30%.

---

## Implementation Plan

### Architecture

```
MarkdownEditor (textarea)
  └── useSlashCommand hook
        ├── detects "/" trigger
        ├── tracks query string
        └── fires onSelect(template | formattingCommand)

SlashCommandPalette component
  ├── positioned absolutely relative to caret
  ├── filters templates + formatting commands
  └── keyboard & click handlers

POST /api/ai/enrich-template  (new)
  └── ai.service.enrichTemplate()
        ├── builds context-aware prompt
        ├── streams Claude response
        └── replaces {{placeholders}} in template
```

### Phase 1 — Palette & Template Insertion (no AI, ~3–4 days)

**Goal:** Ship the slash command UX with instant template insertion but without AI enrichment.

#### 1.1 `useSlashCommand` hook — `apps/web/src/hooks/useSlashCommand.ts`

```ts
interface SlashCommandState {
  active: boolean;
  query: string;       // text typed after "/"
  anchorRect: DOMRect; // for palette positioning
}

function useSlashCommand(
  textareaRef: React.RefObject<HTMLTextAreaElement>,
  value: string,
  onChange: (v: string) => void,
): {
  state: SlashCommandState;
  onSelect: (item: SlashCommandItem) => void;
  onDismiss: () => void;
}
```

Detection logic:
- On every `onChange`, inspect the text from the start of the current line to the cursor.
- If it matches `/\S*` (slash followed by 0+ non-whitespace), set `active = true` and update `query`.
- Compute `anchorRect` from `textarea.getBoundingClientRect()` + caret offset (use a hidden mirror `<div>` technique — same approach used for GitHub, Notion, etc.).
- On `Escape` or a non-`/`-starting edit, set `active = false`.

#### 1.2 `SlashCommandPalette` component — `apps/web/src/components/SlashCommandPalette.tsx`

- Accepts `query`, `anchorRect`, `templates: DocumentTemplate[]`, `onSelect`, `onDismiss`.
- Renders as `position: fixed` portal (via `ReactDOM.createPortal`).
- Groups results: formatting commands first, then templates (built-in, then custom).
- Fuzzy filter: match `query` against template `name` + `description`.
- Keyboard nav with `useEffect` adding `keydown` listener to `window`.

#### 1.3 Wire into `MarkdownEditor`

`MarkdownEditor` currently accepts `value`, `onChange`, `placeholder`. Add:
- `templates?: DocumentTemplate[]` prop (passed down from `DocumentEditor`).
- Mount `SlashCommandPalette` portal when `state.active`.
- When `onSelect` fires with a template, replace the `/query` span in `value` with `template.content` and call `onChange`.

#### 1.4 Load templates in `DocumentEditor`

`DocumentEditor` already fetches templates in `TemplatePicker`. Extract the query into a shared hook or lift it so it's also available when the editor mounts (before the user opens the modal).

```ts
// apps/web/src/pages/DocumentEditor.tsx
const { data: templates } = useQuery<DocumentTemplate[]>({
  queryKey: ['templates', teamId],
  queryFn: () => fetchTemplates(undefined, teamId ?? undefined),
  enabled: true, // always pre-load
});
```

Pass `templates` down to `MarkdownEditor`.

---

### Phase 2 — AI Enrichment (streaming, ~3–4 days)

#### 2.1 Backend: `POST /api/ai/enrich-template`

New route in `apps/api/src/routes/ai.ts`:

```ts
fastify.post('/api/ai/enrich-template', async (req, reply) => {
  const { templateId, documentTitle, documentStage, existingContent, repositoryId } = req.body;
  // look up template skeleton
  // call ai.service.enrichTemplate() — returns a stream
  // pipe SSE back to client
});
```

New method in `apps/api/src/services/ai.service.ts`:

```ts
async enrichTemplate(opts: {
  skeleton: string;          // template content with {{placeholders}}
  documentTitle: string;
  documentStage: DocumentStage;
  existingContent: string;
  repositoryId?: string;
}): Promise<AsyncIterable<string>>
```

Prompt strategy:
- System: "You are a technical writer. Fill in each `{{placeholder}}` in the template below with relevant, specific content. Use the document title, stage, and existing content for context. Return only the filled template — no preamble."
- User: includes skeleton + context.
- Stream token-by-token; client reconstructs the full template.

#### 2.2 Frontend: streaming enrichment

After the hook inserts the template skeleton into the editor:

```ts
const stream = await enrichTemplate({
  templateId,
  documentTitle: doc.title,
  documentStage: doc.stage,
  existingContent: value,
});

for await (const chunk of stream) {
  // replace editor content progressively
  onChange(chunk); // chunk is the full document up to this point
}
```

Show a subtle loading shimmer over the newly-inserted template block during streaming. Use the existing SSE client pattern from `apps/web/src/lib/agent-stream.ts`.

Add to `apps/web/src/lib/api.ts`:

```ts
export async function enrichTemplate(opts: {
  templateId: string;
  documentTitle: string;
  documentStage: string;
  existingContent: string;
  repositoryId?: string;
}): Promise<EventSource>
```

---

### Phase 3 — Formatting Commands & Polish (~1–2 days)

- Implement the non-AI formatting commands (`/h1`, `/h2`, `/table`, etc.) in the hook's `onSelect` handler.
- Prevent palette trigger inside code fences (check if cursor is inside triple-backtick block).
- Prevent trigger when `/` is not at line start (e.g., URLs).
- Add `data-testid` attributes to palette and list items for E2E coverage.
- Write Vitest unit tests for `useSlashCommand` (caret detection, query extraction, dismiss logic).
- Write Playwright E2E test: type `/prd` → select template → verify content inserted.

---

### Files Touched

| File | Change |
|------|--------|
| `apps/web/src/hooks/useSlashCommand.ts` | **New** — slash detection hook |
| `apps/web/src/components/SlashCommandPalette.tsx` | **New** — floating palette UI |
| `apps/web/src/components/MarkdownEditor.tsx` | Add `templates` prop, mount palette portal |
| `apps/web/src/pages/DocumentEditor.tsx` | Pre-load templates, wire `templates` prop |
| `apps/web/src/lib/api.ts` | Add `enrichTemplate()` |
| `apps/api/src/routes/ai.ts` | Add `POST /api/ai/enrich-template` |
| `apps/api/src/services/ai.service.ts` | Add `enrichTemplate()` method |
| `packages/shared/src/types/document.ts` | Add `SlashCommandItem` type if needed |
| `e2e/slash-commands.spec.ts` | **New** — E2E test |

---

### Dependency Notes

- No new npm packages required. Caret position measurement uses a vanilla JS mirror-div technique.
- `ReactDOM.createPortal` is already available (React 18).
- SSE streaming follows the existing pattern in `UnifiedAIPanel` and `agent-stream.ts`.

---

### Open Questions

1. Should slash commands work in the AI chat panel (`UnifiedAIPanel`) as well, or only in the main document editor? (Recommendation: editor only for v1.)
2. Should `/` mid-document (not at line start) trigger the palette? (Recommendation: no — reduces false positives in URLs and file paths.)
3. For custom templates with no `description`, what placeholder text should appear in the palette?
4. Should enrichment be optional — i.e., a UI toggle "AI-fill this template" vs. "Insert skeleton only"?
