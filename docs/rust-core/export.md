# Export and deliverables (AI-72)

Module: `crates/nyx-core/src/export/`. Port of `export.service.ts`, `export-latex.service.ts`,
`export-jupyter.service.ts`, `deliverable.service.ts` and `routes/export.ts`, `routes/deliverables.ts`.

## API

- `ExportFormat` (`Markdown, Txt, Pdf, Docx, Latex, Jupyter`) with `extension()`, `mime()`, `FromStr`.
- `Exporter` trait (one unit struct per format), `exporter_for(format)`.
- `export(&ExportDoc, ExportFormat) -> Result<Vec<u8>>`, `export_with(.., &ExportOptions)` (LaTeX theme).
- `bundle::bundle(&[BundleEntry])`, `bundle::bundle_documents(docs, formats, opts)` (zip + `manifest.json`).
- `deliverable`: `DeliverableType`, `SqliteDeliverables::{generate, get, list_by_document}`,
  `render_deliverable` (no DB), `bundle_stored_documents`. Migration `172_deliverables`.

## Mapping from TS

| TS | Rust |
| --- | --- |
| `exportService.toMarkdown` | `MarkdownExporter` (pass-through) |
| `toPlainText` (regex strip) | `plain.rs` on the `pulldown-cmark` tree, same `Title\n=====\n\n` shape |
| `toPdf` (pdfkit) | `pdf.rs`, hand-written PDF 1.4 writer |
| `toDocx` (docx npm) | `docx.rs`, minimal OOXML over `zip` |
| `markdownToLatex` | `latex.rs`, line-based port, byte-compatible, golden tests |
| `markdownToNotebook` | `jupyter.rs` (serde_json), nbformat 4.5 |
| `generateDeliverable` etc. | `deliverable.rs` |

## Dependency decisions

- `pulldown-cmark` 0.13 (MIT), `default-features = false`.
- `zip` 9 (MIT), `default-features = false, features = ["deflate"]` (already in Cargo.lock via Tauri).
- DOCX: `docx-rs` (MIT) rejected as heavier than needed; hand-written OOXML is ~300 lines and tested.
- PDF: `printpdf` 0.12 (MIT, pulls HTML layout + image stack), `genpdf` (needs TTF files) rejected.
  Base-14 fonts are referenced, not embedded, so no font files ship.

## PDF limits

WinAnsi text only (Latin-1 + common punctuation); other characters become `?`. No images, links,
hyphenation or stream compression. US Letter, 50 pt margins, equal-width table columns. Upgrade path:
embed a TTF with subsetting.

## Verification

`unzip -t` on the docx (also all parts parsed as XML); PDF opened in PdfCraft (1 page, text extracted);
docx opened in WordCraft; ipynb structure validated by `jupyter::validate_notebook`.

## Parity gaps and deliberate differences

- LaTeX keeps the TS limits: only `&` escaped in text, title not emitted, quotes/links untouched.
- Jupyter adds cell `id`s (required by nbformat 4.5); key order alphabetical.
- DOCX handles headings 1 to 6, lists, tables, code, quotes (TS: headings 1 to 3 and bold only).
- PDF renders structure (TS printed raw Markdown text).
- `report` deliverable renders a real Markdown report (TS stored no content); all types are
  accepted (TS route allowed only pdf/markdown/report). Deliverable bytes are not persisted, only the row.
- Soft-deleted documents can still be exported (TS had no check).
- Migration versions: `tests/migrations.rs` used extra version 100; moved to 9000 so ticket migrations (100+NN) can coexist.
