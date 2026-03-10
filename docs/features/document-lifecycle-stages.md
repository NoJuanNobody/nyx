# Document Lifecycle Stages — Context Menu Creation Flow (#35)

**TODO item:** #35
**Status:** TODO
**Priority:** P3 — MVP

---

## Overview

Replace the current modal-based TemplatePicker with a right-click context menu integrated directly into the FileTree. Right-clicking anywhere in the file tree reveals the 5 lifecycle stages as top-level menu items. Hovering over a stage opens a submenu listing the document templates available for that stage, allowing users to create stage-aware documents in a single fluid interaction — no modal, no extra clicks.

## Why this matters

- **Discoverability** — the lifecycle stages are a core SyncDocs concept, but today they're buried behind a "New from Template" button and a modal. Surfacing them in the right-click menu makes them a first-class part of the document creation flow.
- **Speed** — right-click → hover → click is faster than open modal → filter by stage → select template → confirm.
- **Context-aware placement** — right-clicking on a folder creates the document *inside that folder*, preserving the user's organizational intent. Right-clicking on empty space creates at the current root or selected path.
- **Education** — new users learn the lifecycle model organically by seeing the five stages every time they create a document, with stage descriptions and role hints in the menu.

## Current state

| Aspect | Today |
|--------|-------|
| **Right-click menu** | Exists on folders (New doc, New subfolder, Rename, Delete) and documents (Rename, Delete). No stage awareness. |
| **Template creation** | Header button opens `<TemplatePicker>` modal with stage filter tabs and a template grid. Works but is disconnected from the tree. |
| **Stage assignment** | Documents can have a `stage` field (nullable). Set during template creation or editable later. Most users ignore it. |
| **Stage filter** | Dropdown in FileTree header filters the tree by stage. Useful but doesn't help during creation. |

## Proposed interaction

### Right-click on a folder or empty tree space

```
┌──────────────────────────────────┐
│  📄 New blank document           │
│  📁 New subfolder                │
│ ─────────────────────────────── │
│  ● Conception — Idea & Vision   │ ➜ ┌──────────────────────────────┐
│  ● Definition — Product Spec    │   │  Product Brief               │
│  ● Architecture — System Design │   │  User Story Map              │
│  ● Implementation — Dev Specs   │   │  Market Analysis             │
│  ● Execution — Code & Sync     │   │  ───────────────────────────  │
│ ─────────────────────────────── │   │  ＋ Blank Conception doc      │
│  📋 Browse all templates…       │   └──────────────────────────────┘
└──────────────────────────────────┘
```

1. **Right-click** on a folder, a document, or the empty tree area.
2. Top section: quick actions (New blank document, New subfolder) — same as today.
3. Middle section: the 5 lifecycle stages, each with its colored dot, abbreviated label, and subtitle.
4. **Hover** (or arrow-key into) a stage → a submenu flies out listing templates fetched from `GET /api/templates?stage={stage}`.
5. Each submenu also includes a **"Blank {stage} doc"** option at the bottom, for users who want the stage tag but no template content.
6. Bottom section: **"Browse all templates…"** opens the existing TemplatePicker modal as a fallback for users who prefer the grid view.
7. Clicking a template creates the document in the target folder with the template's title, content, and stage pre-filled.

### Right-click on a document

```
┌──────────────────────────────────┐
│  ✏️  Rename                      │
│  🗑  Delete                      │
│ ─────────────────────────────── │
│  Set stage ▸                    │ ➜ ┌──────────────────────────────┐
│  Duplicate                      │   │  ● Conception                │
│                                  │   │  ● Definition                │
│                                  │   │  ● Architecture              │
│                                  │   │  ● Implementation            │
│                                  │   │  ● Execution                 │
│                                  │   │  ───────────────────────────  │
│                                  │   │  ○ Remove stage              │
│                                  │   └──────────────────────────────┘
└──────────────────────────────────┘
```

When right-clicking an existing document, the context menu keeps the current Rename/Delete actions and adds:
- **Set stage** submenu — reassign the document's lifecycle stage without changing content. Shows a checkmark next to the current stage. Includes "Remove stage" to clear.
- **Duplicate** — copy the document (inherits stage).

## Menu anatomy

### Stage items

Each stage row in the context menu includes:

| Element | Source | Purpose |
|---------|--------|---------|
| Colored dot | `STAGES[n].color` hex | Visual stage identity, consistent with badges throughout the app |
| Abbreviation | `STAGES[n].abbr` (CO, DF, AR, IM, EX) | Quick recognition for returning users |
| Label | `STAGES[n].label` | Full stage name |
| Subtitle | `STAGES[n].subtitle` | One-liner explaining the stage's purpose |

### Template submenu items

| Element | Source | Purpose |
|---------|--------|---------|
| Template name | `template.name` | Primary label |
| Description | `template.description` (truncated) | Tooltip or secondary line |
| Stage badge | Inherited from parent menu | Reinforcement (shown as small colored dot) |

### Keyboard navigation

- **Arrow keys** navigate the menu and open/close submenus (right arrow opens, left arrow closes).
- **Enter** selects the focused item.
- **Escape** closes the menu.
- Typing letters jumps to the first matching item (standard menu behavior).

## Template data source

Templates are fetched from `GET /api/templates` (same endpoint the TemplatePicker uses today). The context menu groups them by stage client-side.

- **Cache strategy:** Templates are fetched once on FileTree mount and cached via React Query (`staleTime: 5m`). The submenu reads from cache — no request on hover.
- **Empty stages:** If a stage has zero templates, the submenu shows only the "Blank {stage} doc" option. The stage is never hidden — all five stages are always visible to reinforce the lifecycle model.
- **Loading state:** If templates haven't loaded yet, the submenu shows a spinner. Rare since they're pre-fetched.

## Stage metadata in the menu

To make the context menu educational, each stage row optionally shows a tooltip on hover with richer context:

| Stage | Tooltip |
|-------|---------|
| Conception | "Capture the initial idea, problem space, and vision. Typically owned by PMs and founders." |
| Definition | "Translate the idea into a complete product specification. Owned by PMs and designers." |
| Architecture | "Design the system that implements the specification. Owned by tech leads and senior engineers." |
| Implementation | "Create developer-ready specs for AI coding agents. Owned by engineers and QA." |
| Execution | "Track the living codebase and keep documentation in sync. Owned by engineers and DevOps." |

These map directly to `STAGES[n].who` and `STAGES[n].purpose` from `apps/web/src/lib/stages.ts`.

## Relationship to existing components

| Component | Change |
|-----------|--------|
| `FileTree.tsx` | Replace inline context menu `<div>` with new `<ContextMenu>` component. Wire stage/template selection to existing `createDocument` mutation. |
| `TemplatePicker.tsx` | **Keep** — still accessible via "Browse all templates…" menu item and the header button. Not deleted. |
| `stages.ts` | No changes — all stage metadata already exported. |
| `apps/api/src/routes/templates.ts` | No changes — `GET /api/templates` already returns all templates with stage field. |

## Design considerations

### Menu positioning
- Menu appears at cursor position, clamped to viewport edges.
- Submenu opens to the right by default; flips to left if near the right viewport edge.
- On narrow screens (< 640px), the submenu could render inline (accordion-style) instead of as a flyout.

### Visual style
- Matches the existing FileTree context menu aesthetic (same background, border radius, shadow, font).
- Stage dots use the same color palette as the stage filter dropdown and document badges.
- Subtle separator lines between the three sections (quick actions, stages, browse all).
- Hover state: background highlight matching the stage's color at low opacity (e.g., `bg-amber-50` for Conception).

### Animation
- Menu appears with a subtle scale-in (matching existing context menu).
- Submenu slides in from the left edge with a short delay (~100ms) to prevent accidental triggers when moving the cursor across stage items.

## Open questions

- ~~**Custom templates**~~ — **RESOLVED:** Yes, teams can create custom templates and assign them to stages. Deferred to P4 post-MVP as #48. See `docs/features/custom-templates-and-stages.md`.
- ~~**Drag to reorder stages?**~~ — **RESOLVED:** Yes, teams can define custom stages and reorder them. Deferred to P4 post-MVP as #48. See `docs/features/custom-templates-and-stages.md`.
- ~~**Stage onboarding**~~ — **RESOLVED:** The context menu tooltips with stage descriptions and role hints (see "Stage metadata in the menu" section) provide organic education. No separate onboarding flow needed.
- ~~**Mobile / touch**~~ — **RESOLVED:** App is desktop-only for MVP. Mobile is post-MVP; no touch consideration needed now.
- ~~**AI suggestion**~~ — **RESOLVED:** Yes, but handled by the AI Advisor panel (#49), not inline in the context menu. When a blank stage doc is created and prior-stage docs exist, the AI Advisor surfaces a "Pre-fill from {previous stage} docs?" notification with a Generate/Dismiss CTA. See `docs/features/ai-advisor-panel.md`.
