# Nyx designer brief (concept 02, Constellation N)

Draft for Alejandro's approval. If a different concept is picked, this brief adapts: only section 2 changes.

## 1. Product context
Nyx is an open-source, agent-native desktop app (Rust, Tauri 2) for product versioning: docs, code and team workflow always in sync. Named for the Greek primordial goddess of night. Credits are agent-native utility tokens spent by external agents via MCP/CLI, never sold. Audience: engineers and agent builders. Tone: calm, precise, a little mythic. Not corporate, not cute. Nyx is its own product mark (the nonprofit lab AI Messiah is separate) but shares palette tokens.

## 2. The concept
An "N" drawn as five stars (nodes) joined by thin lines, reading like a commit graph under a night sky. Reference: `docs/brand/concepts/02-constellation-n.svg`. The reference is a sketch; you own the final geometry.
- Make it distinct from generic network/graph logos: vary node sizes, keep exactly one violet node (the sync point, center), consider a slight asymmetry or one dashed/ghost link.
- Nodes and lines must keep a consistent stroke-to-node ratio so the N survives 16px.
- Optional secondary motif for launch pages: the Open Eclipse (`03-open-eclipse.svg`).

## 3. Colors
| Token | Hex | Use |
|---|---|---|
| Night navy | `#0B1437` | Dark background, mark on light |
| Deep navy 2 | `#111B4A` | Surfaces on dark |
| Violet | `#8B5CF6` | Accent node, highlights on dark |
| Violet (light bg) | `#7C3AED` | Accent on white (contrast) |
| Star white | `#F4F2FF` | Mark and wordmark on dark |
| Black / white | `#000000` / `#FFFFFF` | One-color versions |

Check WCAG contrast on every pairing; violet `#8B5CF6` is for dark backgrounds, use `#7C3AED` on light.

## 4. Typography (open source only)
- Wordmark: Space Grotesk (SIL OFL) SemiBold as the starting point, or Inter / Manrope. Custom-set and outline the final wordmark; tune the "y" and "x" to the N's angles.
- Product/UI pairing: Inter (UI), JetBrains Mono (code).
- Case: "Nyx" title case. Do not use all caps.

## 5. Clear space and sizes
- Clear space: at least the width of one node diameter (x) on all sides of the lockup; x = node diameter of the mark.
- Min size: icon-only 16px (favicon, tray); full lockup min 96px wide. Below 24px use the simplified icon cut (thicker strokes, no ghost links).
- Lockup: mark left, wordmark right, wordmark cap height about 45% of mark height, gap = 1.5x.

## 6. Deliverables
1. Full lockup (horizontal) and stacked lockup, SVG with outlined text.
2. Icon-only mark, 16/24/32px hand-tuned pixel-fit versions plus master SVG.
3. One-color (black and white) versions of lockup and icon.
4. Light and dark variants of lockup and icon.
5. App icon set for Tauri bundles: `icon.png` 1024, 512, 256, 128, 32, `icon.icns` (macOS), `icon.ico` (Windows multi-size 16-256), plus `128x128@2x`; macOS squircle safe-area applied and a flat Linux variant.
6. Favicon set: `favicon.svg`, `favicon.ico`, 180px apple-touch, 192/512 PWA.
7. Social: 1280x640 GitHub social preview, 400x400 avatar.
8. Source files (Figma, SVG) and a one-page usage guide. All delivered under an open license compatible with the project (license decision pending, Alejandro).

## 7. Do
- Keep the mark on night navy or white with at least 4.5:1 contrast.
- Use the violet node as the only accent.
- Test at 16px on dark and light OS chrome before sign-off.
- Provide outlined text only; no font dependencies in deliverables.

## 8. Don't
- No gradients, glows, drop shadows or 3D.
- No literal moon-and-stars clipart, no circuit-board traces (that is the old logo).
- No extra nodes beyond five or extra colors beyond the palette.
- Don't stretch, rotate, outline or recolor the mark; don't put it on busy photos.
- Don't use a distinctive trademarked typeface or reuse another project's mark.
