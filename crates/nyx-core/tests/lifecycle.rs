//! Golden and cross-module tests for `nyx_core::lifecycle`.
//! Regenerate goldens with `UPDATE_GOLDEN=1 cargo test -p nyx-core --test lifecycle`.

#![allow(clippy::unwrap_used, clippy::assert_is_empty)]

use std::path::PathBuf;

use nyx_core::lifecycle::template::{completeness, MarkdownDoc};
use nyx_core::lifecycle::{
    ensure_builtin_pipelines, instantiate, plan_transition, render, Registry, TemplateDef,
    TransitionKind, TransitionPolicy, Vars,
};
use nyx_core::store::Db;

fn golden(name: &str, actual: &str) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(name);
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(&path, actual).unwrap();
    }
    let want = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("missing golden {name}"));
    assert_eq!(actual, want, "golden {name} differs");
}

fn tpl(pipeline: &str, stage: &str, name: &str) -> TemplateDef {
    Registry::builtin()
        .get(pipeline)
        .unwrap()
        .template(stage, name)
        .unwrap_or_else(|| panic!("{pipeline}/{stage}/{name}"))
        .clone()
}

#[test]
fn release_notes_golden() {
    let t = tpl("software_development", "execution", "Release Notes");
    let v = Vars::new()
        .with("version", "2.4.0")
        .with("date", "2026-10-30");
    golden("release_notes.md", &instantiate(&t, &v).unwrap().content);
}

#[test]
fn adr_golden_with_unfilled_placeholders() {
    let t = tpl(
        "software_development",
        "architecture",
        "Architecture Decision Record (ADR)",
    );
    let v = Vars::new().with("decision_title", "Use SQLite for local storage");
    golden("adr.md", &instantiate(&t, &v).unwrap().content);
}

#[test]
fn custom_variable_template_golden() {
    let t = TemplateDef {
        stage: "s".into(),
        name: "Brief".into(),
        description: String::new(),
        sort_order: 0,
        content: "# {{project}} brief\n\nOwner: {{owner|unassigned}}\nDue: {{due}}\nLiteral: \\{{project}}\n\n## Scope\n<!-- {{project}} scope -->\n".into(),
    };
    let r = instantiate(&t, &Vars::new().with("project", "Apollo")).unwrap();
    assert_eq!(r.unresolved, ["due"]);
    golden("brief.md", &r.content);
}

#[test]
fn every_builtin_template_renders_unchanged_without_variables_and_round_trips_sections() {
    for (p, t) in Registry::builtin().all_templates() {
        let r = render(&t.content, &Vars::new()).unwrap();
        assert_eq!(r.content, t.content, "{}/{}", p.slug, t.name);
        assert!(r.unresolved.is_empty());
        let doc = MarkdownDoc::parse(&t.content);
        assert_eq!(doc.to_markdown(), t.content, "{}/{}", p.slug, t.name);
        assert!(
            t.content.starts_with("# "),
            "{}/{} should start with a title",
            p.slug,
            t.name
        );
        // a pristine template scores as entirely unfilled
        let c = completeness(&t.content, &t.content);
        assert!(
            c.ratio < 1.0 && c.missing.is_empty(),
            "{}/{} {c:?}",
            p.slug,
            t.name
        );
    }
}

#[test]
fn filling_a_template_raises_completeness() {
    let t = tpl("software_development", "execution", "Release Notes");
    let mut doc = MarkdownDoc::parse(&t.content);
    assert!(doc.set_body("Highlights", "Faster search and offline mode."));
    assert!(doc.set_body("New Features", "- Offline mode\n"));
    let c = completeness(&t.content, &doc.to_markdown());
    assert!(c.missing.is_empty());
    assert!(c.unfilled.contains(&"Known Issues".to_owned()));
    assert!(c.ratio > 0.0 && c.ratio < 1.0);
}

#[test]
fn every_pipeline_seeds_and_walks_through_the_store() {
    let mut db = Db::open_in_memory().unwrap();
    let report = ensure_builtin_pipelines(&mut db).unwrap();
    assert_eq!(
        report.lifecycles_created.len(),
        Registry::builtin().list().len()
    );
    for p in Registry::builtin().list() {
        let last = p.stages.last().unwrap();
        let t = plan_transition(
            p,
            Some(&p.first_stage().slug),
            Some(&last.slug),
            TransitionPolicy::Free,
        )
        .unwrap();
        assert_eq!(t.kind, TransitionKind::Skip);
        assert_eq!(t.skipped.len(), p.stages.len() - 2);
    }
}

#[test]
fn contributors_can_add_a_pipeline_from_json() {
    let mut json = serde_json::to_value(Registry::builtin().get("game_design").unwrap()).unwrap();
    json["slug"] = "my_domain".into();
    json["is_default"] = false.into();
    let reg = Registry::from_json([json.to_string().as_str()]).unwrap();
    assert!(reg.get("my_domain").is_some());
}
