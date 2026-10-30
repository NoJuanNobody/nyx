//! Idempotent seeding of pipelines into [`crate::store::lifecycles`].
//!
//! Port of `ensureLifecycles()` (`seed-lifecycles.ts`, `ON CONFLICT DO NOTHING`): missing
//! lifecycles and stages are inserted, existing ones are never modified. Unlike the TS script a
//! seeded pipeline never steals the default flag from an already existing default.
//!
//! Templates are not stored in SQLite (the `document_templates` table is not ported): they are
//! served from the embedded [`Registry`], see [`super::pipeline::PipelineDef::templates_for`].

use rusqlite::Connection;
use serde::Serialize;

use super::pipeline::{PipelineDef, Registry, StageDef};
use crate::error::Result;
use crate::model::{LifecycleStage, NewLifecycle};
use crate::store::lifecycles::{LifecycleRepo, SqliteLifecycles};
use crate::store::Db;

/// What a seeding run did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SeedReport {
    /// Slugs of lifecycles inserted.
    pub lifecycles_created: Vec<String>,
    /// Slugs of lifecycles that already existed.
    pub lifecycles_existing: Vec<String>,
    /// Stages inserted.
    pub stages_created: usize,
    /// Stages that already existed and were left untouched.
    pub stages_existing: usize,
}

fn stage_row(lifecycle_id: &str, s: &StageDef) -> LifecycleStage {
    LifecycleStage {
        id: String::new(),
        lifecycle_id: lifecycle_id.to_owned(),
        slug: s.slug.clone(),
        sort_order: s.sort_order,
        label: s.label.clone(),
        abbreviation: s.abbreviation.clone(),
        subtitle: s.subtitle.clone(),
        color: s.color.clone(),
        text_color: s.text_color.clone(),
        dot_color: s.dot_color.clone(),
        border_color: s.border_color.clone(),
        hex: s.hex.clone(),
        who: s.who.clone(),
        description: s.description.clone(),
        icon: s.icon.clone(),
        ai: s.ai.clone(),
        output: s.output.clone(),
        docs: s.docs.clone(),
    }
}

fn seed_one(repo: &SqliteLifecycles<'_>, p: &PipelineDef, report: &mut SeedReport) -> Result<()> {
    let lifecycle = if let Some(existing) = repo.find_by_slug(&p.slug)? {
        report.lifecycles_existing.push(p.slug.clone());
        existing
    } else {
        let has_default = repo.default_lifecycle()?.is_some();
        let created = repo.create(&NewLifecycle {
            slug: p.slug.clone(),
            label: p.label.clone(),
            description: p.description.clone(),
            icon: p.icon.clone(),
            is_default: p.is_default && !has_default,
            sort_order: p.sort_order,
        })?;
        report.lifecycles_created.push(p.slug.clone());
        created
    };
    let have: Vec<String> = repo
        .stages(&lifecycle.id)?
        .into_iter()
        .map(|s| s.slug)
        .collect();
    for s in &p.stages {
        if have.contains(&s.slug) {
            report.stages_existing += 1;
        } else {
            repo.add_stage(&stage_row(&lifecycle.id, s))?;
            report.stages_created += 1;
        }
    }
    Ok(())
}

/// Seed every pipeline of `registry` using `conn` (pass a transaction for atomicity).
pub fn seed_pipelines(conn: &Connection, registry: &Registry) -> Result<SeedReport> {
    let repo = SqliteLifecycles::new(conn);
    let mut report = SeedReport::default();
    // Default first so it wins the default flag regardless of sort order.
    let mut order: Vec<&PipelineDef> = registry.list().iter().collect();
    order.sort_by_key(|p| !p.is_default);
    for p in order {
        seed_one(&repo, p, &mut report)?;
    }
    Ok(report)
}

/// Seed the embedded pipelines in one transaction (TS: `ensureLifecycles`). Safe to call on every
/// start-up.
pub fn ensure_builtin_pipelines(db: &mut Db) -> Result<SeedReport> {
    db.transaction(|conn| seed_pipelines(conn, Registry::builtin()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeding_is_idempotent_and_complete() {
        let mut db = Db::open_in_memory().unwrap();
        let first = ensure_builtin_pipelines(&mut db).unwrap();
        assert_eq!(first.lifecycles_created.len(), 20);
        assert_eq!(first.stages_created, 5 + 6 * 18 + 8);
        assert_eq!(first.stages_existing, 0);
        let again = ensure_builtin_pipelines(&mut db).unwrap();
        assert_eq!(again.lifecycles_created.len(), 0);
        assert_eq!(again.lifecycles_existing.len(), 20);
        assert_eq!(again.stages_created, 0);
        assert_eq!(again.stages_existing, first.stages_created);

        let repo = SqliteLifecycles::new(db.conn());
        assert_eq!(repo.list().unwrap().len(), 20);
        assert_eq!(
            repo.default_lifecycle().unwrap().unwrap().slug,
            "software_development"
        );
    }

    #[test]
    fn stored_stages_match_the_definition() {
        let mut db = Db::open_in_memory().unwrap();
        ensure_builtin_pipelines(&mut db).unwrap();
        let repo = SqliteLifecycles::new(db.conn());
        for p in Registry::builtin().list() {
            let lc = repo.find_by_slug(&p.slug).unwrap().unwrap();
            let stages = repo.stages(&lc.id).unwrap();
            let got: Vec<&str> = stages.iter().map(|s| s.slug.as_str()).collect();
            let want: Vec<&str> = p.stages.iter().map(|s| s.slug.as_str()).collect();
            assert_eq!(got, want, "{}", p.slug);
            assert_eq!(stages[0].docs, p.stages[0].docs);
            assert_eq!(stages[0].hex, p.stages[0].hex);
        }
    }

    #[test]
    fn existing_rows_are_not_modified_and_missing_stages_are_filled() {
        let mut db = Db::open_in_memory().unwrap();
        {
            let repo = SqliteLifecycles::new(db.conn());
            let mut nl = NewLifecycle::new("software_development", "Custom Label");
            nl.is_default = true;
            let lc = repo.create(&nl).unwrap();
            repo.add_stage(&LifecycleStage::draft(
                &lc.id,
                "conception",
                "My Conception",
                0,
            ))
            .unwrap();
        }
        let report = ensure_builtin_pipelines(&mut db).unwrap();
        assert_eq!(report.lifecycles_created.len(), 19);
        assert_eq!(report.stages_existing, 1);
        let repo = SqliteLifecycles::new(db.conn());
        let lc = repo.find_by_slug("software_development").unwrap().unwrap();
        assert_eq!(lc.label, "Custom Label");
        let stages = repo.stages(&lc.id).unwrap();
        assert_eq!(stages.len(), 5);
        assert_eq!(stages[0].label, "My Conception");
    }

    #[test]
    fn a_seeded_pipeline_never_steals_an_existing_default() {
        let mut db = Db::open_in_memory().unwrap();
        {
            let repo = SqliteLifecycles::new(db.conn());
            let mut nl = NewLifecycle::new("mine", "Mine");
            nl.is_default = true;
            repo.create(&nl).unwrap();
        }
        ensure_builtin_pipelines(&mut db).unwrap();
        let repo = SqliteLifecycles::new(db.conn());
        assert_eq!(repo.default_lifecycle().unwrap().unwrap().slug, "mine");
        assert!(
            !repo
                .find_by_slug("software_development")
                .unwrap()
                .unwrap()
                .is_default
        );
    }
}
