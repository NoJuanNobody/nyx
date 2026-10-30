# Nyx logo concepts (AI-83)

Status: proposal. The final pick is Alejandro's. `logo.jpeg` (repo root, circuit-trace "N" on navy) is untouched.

Each concept is a hand-written SVG lockup (mark + "Nyx" wordmark, 640x220). The mark is built on a 100x100 grid so it scales from 16px to 512px+. Wordmark is live text (Space Grotesk, fallback Inter/system); the designer will outline and custom-set it.

Files, per concept `NN-name`:
- `concepts/NN-name.svg` dark variant (navy tile, off-white + violet)
- `concepts/NN-name-light.svg` light variant (white tile, navy + violet)
- `concepts/NN-name-mono.svg` one-color variant (pure black, no accent; invert to white for dark use)

Palette (shared with the AI Messiah family, brand-family note in the ticket): night navy `#0B1437`, violet `#8B5CF6` (`#7C3AED` on light), star white `#F4F2FF`.

## Contact sheet

| # | Concept | Idea | Rationale | Strengths | Risks | Favicon (16px) |
|---|---------|------|-----------|-----------|-------|----------------|
| 01 | Night Veil Bracket | Two curly braces face each other; the lens-shaped gap is a night sky with a 4-point star and two dots. Left brace white, right violet. | Code (braces) plus night (Nyx). Two halves read as docs and code held in sync. | Instantly "developer"; strong silhouette; two-tone carries the sync idea. | Braces are a common dev cliche; the crescent reading is weak (reads as lens or hourglass); star and dots disappear small. | Good: silhouette holds. Drop the inner dots at 16px. |
| 02 | Constellation N | An N drawn as five stars joined by thin lines, like a commit graph. Center star is violet. | Docs, code and tickets as connected nodes; nods to the existing `logo.jpeg` N. Night sky plus version graph in one shape. | Best letterform; simplest geometry; scales, one-color and tiny sizes all work; ownable "N"; ties to git-like versioning. | Node-and-line N is a crowded idea (graph/network logos); needs custom proportions to feel distinct. | Excellent: five dots plus strokes survive at 16px. |
| 03 | Open Eclipse | A ring open at the upper right (open source) around a violet disc, with one star escaping through the gap. | Eclipse = Nyx (night swallowing light); the gap is the open-source gesture. Strongest story. | Memorable narrative; very simple; great app icon in a rounded square. | No letterform, so weaker recall without the wordmark; resembles generic "loading/search" rings; the star is tiny at small sizes. | Good: ring and disc read; star becomes a speck (optional at 16px). |
| 04 | Owl of Night | Geometric owl head with ear tufts; eyes are diff markers `+` and `-`. | Night and wisdom; diff markers say version control. | Most character, mascot potential, ties to diffs. | Owl is heavily used (Duolingo, others) and Greek-owl cliche is Athena, not Nyx; cuter and less serious; most complex. | Weak: the + / - markers vanish; reads as a cat. Needs a simplified 16px cut. |
| 05 | Token Moon | A coin ring with a dashed inner track around a violet crescent and a star. | Credits are agent-native utility tokens; the moon is the coin. | Unique link to the token model; strong app icon. | Coin reads as a payment/crypto mark, which clashes with "tokens are never sold"; weaker tie to docs/code sync. | Good: ring plus crescent legible; dashes must be dropped. |

Not drawn from the ticket list: 4 "Nyx's Mantle" (hooded goddess silhouette with document cloak). Too detailed to survive 16px; the designer can revisit it as an illustration, not a logo.

## Recommendation

Pick **02 Constellation N** as the primary mark, with **03 Open Eclipse** as the second option (and possible secondary motif for the open-source launch page). Reasons: it is the only concept that is also a clean letterform, it scores best at 16px, it expresses "docs, code and workflow in sync" as a connected graph, and it carries forward the N from the current logo. The designer should differentiate it from generic network marks (unequal node sizes, one violet node, a slight skew or a missing link) as covered in `designer-brief.md`.

## Verification

All SVGs pass `xmllint --noout`. Rendered with macOS `qlmanage` and eyeballed; renders are not committed. Fonts are system fallbacks in the renders, so wordmark spacing is indicative only.
