//! End-to-end export tests: every format on a realistic document, deliverables against SQLite,
//! and the zip bundle. External tools (`unzip`) are used when present but never required.
mod common;

use std::io::{Cursor, Read};
use std::process::Command;

use common::{fixture, new_doc};
use nyx_core::export::deliverable::{
    bundle_stored_documents, DeliverableRepo, DeliverableType, SqliteDeliverables,
};
use nyx_core::export::{
    export, export_with, jupyter, pdf, ExportDoc, ExportFormat, ExportOptions, LatexTheme,
};
use nyx_core::Error;

const SAMPLE: &str = "# Research Paper\n\n## Abstract\n\nThis paper explores **important** topics in *science* & `code`.\n\n1. Collect data\n2. Analyze\n\n- bullet\n  - nested\n\n> a quote\n\n```python\nimport numpy as np\nprint(np.arange(3))\n```\n\n| Metric | Value |\n| --- | --- |\n| Accuracy | 95% |\n\n---\n\nTrailing paragraph with caf\u{e9} and \u{201C}quotes\u{201D}.\n";

fn doc() -> ExportDoc {
    ExportDoc::new("Research Paper: v1", SAMPLE)
}

#[test]
fn docx_is_a_valid_zip_and_survives_unzip_t() {
    let bytes = export(&doc(), ExportFormat::Docx).unwrap();
    let mut z = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
    let mut xml = String::new();
    z.by_name("word/document.xml")
        .unwrap()
        .read_to_string(&mut xml)
        .unwrap();
    assert!(xml.contains("Research Paper: v1"));
    assert!(xml.contains("import numpy as np"));

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("out.docx");
    std::fs::write(&path, &bytes).unwrap();
    if let Ok(out) = Command::new("unzip").arg("-t").arg(&path).output() {
        assert!(
            out.status.success(),
            "unzip -t failed: {}",
            String::from_utf8_lossy(&out.stdout)
        );
    }
}

#[test]
fn pdf_has_header_and_pages() {
    let bytes = export(&doc(), ExportFormat::Pdf).unwrap();
    assert!(bytes.starts_with(b"%PDF-"));
    assert!(pdf::page_count(&bytes) >= 1);
    let tail = String::from_utf8_lossy(&bytes[bytes.len() - 8..]).into_owned();
    assert!(tail.contains("%%EOF"));
    // Text is present in the content stream (uncompressed, Latin-1 escaped).
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("(Research Paper: v1)"));
    assert!(text.contains("caf\\351"));
}

#[test]
fn notebook_json_validates() {
    let bytes = export(&doc(), ExportFormat::Jupyter).unwrap();
    let nb: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    jupyter::validate_notebook(&nb).unwrap();
    let kinds: Vec<&str> = nb["cells"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["cell_type"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["markdown", "code", "markdown"]);
}

#[test]
fn latex_theme_option_is_honoured() {
    let opts = ExportOptions {
        latex_theme: LatexTheme::Ieee,
    };
    let tex = String::from_utf8(export_with(&doc(), ExportFormat::Latex, &opts).unwrap()).unwrap();
    assert!(tex.starts_with("\\documentclass[conference]{IEEEtran}"));
    assert!(tex.contains("\\section{Research Paper}"));
    assert!(tex.trim_end().ends_with("\\end{document}"));
}

#[test]
fn txt_and_markdown() {
    let txt = String::from_utf8(export(&doc(), ExportFormat::Txt).unwrap()).unwrap();
    assert!(txt.starts_with("Research Paper: v1\n=================="));
    assert!(txt.contains("important topics in science & code."));
    assert!(!txt.contains("**"));
    assert_eq!(
        export(&doc(), ExportFormat::Markdown).unwrap(),
        SAMPLE.as_bytes()
    );
}

#[test]
fn deliverables_persist_list_and_get() {
    let f = fixture();
    let d = new_doc(&f, "Plan v1", SAMPLE);
    let repo = SqliteDeliverables::new(f.db.conn());

    let pdf = repo
        .generate(
            &d.id,
            "review",
            DeliverableType::Pdf,
            &ExportOptions::default(),
        )
        .unwrap();
    assert_eq!(pdf.record.file_name, "Plan_v1_review.pdf");
    assert_eq!(
        pdf.record.file_url,
        format!("/deliverables/{}/Plan_v1_review.pdf", d.id)
    );
    assert!(pdf.bytes.starts_with(b"%PDF"));

    let report = repo
        .generate(
            &d.id,
            "review",
            DeliverableType::Report,
            &ExportOptions::default(),
        )
        .unwrap();
    assert_eq!(report.record.file_name, "Plan_v1_review_report.md");
    assert!(String::from_utf8(report.bytes)
        .unwrap()
        .contains("**Stage:** review"));

    let list = repo.list_by_document(&d.id).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].kind, DeliverableType::Pdf);
    assert_eq!(repo.get(&pdf.record.id).unwrap(), pdf.record);
    assert_eq!(pdf.record.metadata.as_ref().unwrap()["title"], "Plan v1");
}

#[test]
fn deliverable_errors() {
    let f = fixture();
    let repo = SqliteDeliverables::new(f.db.conn());
    let opts = ExportOptions::default();
    assert!(matches!(
        repo.generate("missing", "s", DeliverableType::Pdf, &opts),
        Err(Error::NotFound(_))
    ));
    let d = new_doc(&f, "T", "x");
    assert!(matches!(
        repo.generate(&d.id, " ", DeliverableType::Pdf, &opts),
        Err(Error::Invalid(_))
    ));
    assert!(matches!(repo.get("nope"), Err(Error::NotFound(_))));
    assert_eq!(repo.list_by_document(&d.id).unwrap(), vec![]);
}

#[test]
fn bundle_of_stored_documents() {
    let f = fixture();
    let a = new_doc(&f, "Alpha", "# A\n\n```python\nx=1\n```");
    let b = new_doc(&f, "Beta", "# B");
    let zipped = bundle_stored_documents(
        f.db.conn(),
        &[&a.id, &b.id],
        &[
            ExportFormat::Markdown,
            ExportFormat::Pdf,
            ExportFormat::Jupyter,
        ],
        &ExportOptions::default(),
    )
    .unwrap();
    let mut z = zip::ZipArchive::new(Cursor::new(&zipped)).unwrap();
    let mut names: Vec<String> = (0..z.len())
        .map(|i| z.by_index(i).unwrap().name().unwrap().to_string())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "Alpha.ipynb",
            "Alpha.md",
            "Alpha.pdf",
            "Beta.ipynb",
            "Beta.md",
            "Beta.pdf",
            "manifest.json"
        ]
    );
    let mut pdf_bytes = Vec::new();
    z.by_name("Beta.pdf")
        .unwrap()
        .read_to_end(&mut pdf_bytes)
        .unwrap();
    assert!(pdf_bytes.starts_with(b"%PDF"));

    assert!(matches!(
        bundle_stored_documents(
            f.db.conn(),
            &["nope"],
            &[ExportFormat::Txt],
            &ExportOptions::default()
        ),
        Err(Error::NotFound(_))
    ));
}
