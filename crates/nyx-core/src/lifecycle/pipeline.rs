//! Typed pipeline definitions, validation and the embedded [`Registry`].

use std::collections::HashSet;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

include!(concat!(env!("OUT_DIR"), "/pipeline_files.rs"));

/// Slug of the default pipeline (TS: `DEFAULT_LIFECYCLE_SLUG`).
pub const DEFAULT_PIPELINE_SLUG: &str = "software_development";

/// One stage of a pipeline, including display metadata (TS: `StageSeed` + `StageInfo`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StageDef {
    /// Slug, unique within the pipeline (TS `StageInfo.id`).
    pub slug: String,
    /// Position, strictly increasing within the pipeline.
    pub sort_order: i64,
    /// Display label.
    pub label: String,
    /// Two letter abbreviation.
    pub abbreviation: String,
    /// Short subtitle.
    pub subtitle: String,
    /// Tailwind background class (display token, kept for UI parity).
    pub color: String,
    /// Tailwind text class.
    pub text_color: String,
    /// Tailwind dot class.
    pub dot_color: String,
    /// Tailwind border class.
    pub border_color: String,
    /// `#RRGGBB` accent colour.
    pub hex: String,
    /// Roles that own the stage.
    pub who: String,
    /// What happens in the stage.
    pub description: String,
    /// Icon glyph.
    pub icon: String,
    /// Hint about how an external agent can help at this stage.
    pub ai: String,
    /// Expected output of the stage.
    pub output: String,
    /// Suggested document names.
    pub docs: Vec<String>,
    /// Suggested agent actions for this stage (TS: `suggestions[stage]`).
    #[serde(default)]
    pub suggestions: Vec<String>,
}

/// A document template belonging to one stage of a pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateDef {
    /// Stage slug the template belongs to.
    pub stage: String,
    /// Name, unique per stage.
    pub name: String,
    /// One line description.
    pub description: String,
    /// Order within the stage.
    pub sort_order: i64,
    /// Markdown body. May contain `{{variable}}` / `{{variable|default}}` placeholders.
    pub content: String,
}

/// A domain pipeline (TS "lifecycle"): ordered stages plus templates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PipelineDef {
    /// Unique slug, `[a-z][a-z0-9_]*`.
    pub slug: String,
    /// Display label.
    pub label: String,
    /// Description.
    pub description: String,
    /// Icon glyph.
    pub icon: String,
    /// Whether this is the default pipeline.
    pub is_default: bool,
    /// Sort order across pipelines.
    pub sort_order: i64,
    /// Narrative sentences between consecutive stages (empty, or `stages.len() - 1` entries).
    #[serde(default)]
    pub connectors: Vec<String>,
    /// Ordered stages.
    pub stages: Vec<StageDef>,
    /// Templates, each bound to one of the stages.
    #[serde(default)]
    pub templates: Vec<TemplateDef>,
}

fn is_slug(s: &str) -> bool {
    let mut c = s.chars();
    matches!(c.next(), Some('a'..='z')) && c.all(|c| matches!(c, 'a'..='z' | '0'..='9' | '_'))
}

fn is_hex_colour(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

impl PipelineDef {
    /// Parse one pipeline from JSON and validate it.
    pub fn from_json(json: &str) -> Result<Self> {
        let def: Self = serde_json::from_str(json)?;
        def.validate()?;
        Ok(def)
    }

    /// Check structural invariants. Errors name the pipeline and the offending item.
    pub fn validate(&self) -> Result<()> {
        let at = |m: String| Error::Invalid(format!("pipeline '{}': {m}", self.slug));
        if !is_slug(&self.slug) {
            return Err(at("slug must match [a-z][a-z0-9_]*".into()));
        }
        if self.label.trim().is_empty() {
            return Err(at("label is required".into()));
        }
        if self.stages.len() < 2 {
            return Err(at("a pipeline needs at least two stages".into()));
        }
        let mut seen = HashSet::new();
        let mut prev: Option<i64> = None;
        for s in &self.stages {
            if !is_slug(&s.slug) {
                return Err(at(format!(
                    "stage slug '{}' must match [a-z][a-z0-9_]*",
                    s.slug
                )));
            }
            if !seen.insert(s.slug.as_str()) {
                return Err(at(format!("duplicate stage '{}'", s.slug)));
            }
            if s.label.trim().is_empty() || s.abbreviation.trim().is_empty() {
                return Err(at(format!(
                    "stage '{}' needs a label and abbreviation",
                    s.slug
                )));
            }
            if !is_hex_colour(&s.hex) {
                return Err(at(format!(
                    "stage '{}' hex '{}' is not #RRGGBB",
                    s.slug, s.hex
                )));
            }
            if prev.is_some_and(|p| s.sort_order <= p) {
                return Err(at(format!(
                    "stage '{}' sort_order must increase in listed order",
                    s.slug
                )));
            }
            prev = Some(s.sort_order);
        }
        if !self.connectors.is_empty() && self.connectors.len() != self.stages.len() - 1 {
            return Err(at(format!(
                "connectors must be empty or have {} entries, got {}",
                self.stages.len() - 1,
                self.connectors.len()
            )));
        }
        let mut keys = HashSet::new();
        for t in &self.templates {
            if !seen.contains(t.stage.as_str()) {
                return Err(at(format!(
                    "template '{}' references unknown stage '{}'",
                    t.name, t.stage
                )));
            }
            if t.name.trim().is_empty() || t.content.trim().is_empty() {
                return Err(at(format!(
                    "template in stage '{}' needs name and content",
                    t.stage
                )));
            }
            if !keys.insert((t.stage.as_str(), t.name.as_str())) {
                return Err(at(format!(
                    "duplicate template '{}' in stage '{}'",
                    t.name, t.stage
                )));
            }
            super::template::check_syntax(&t.content)
                .map_err(|m| at(format!("template '{}': {m}", t.name)))?;
        }
        Ok(())
    }

    /// Stage by slug.
    pub fn stage(&self, slug: &str) -> Option<&StageDef> {
        self.stages.iter().find(|s| s.slug == slug)
    }

    /// Zero based position of a stage.
    pub fn stage_index(&self, slug: &str) -> Option<usize> {
        self.stages.iter().position(|s| s.slug == slug)
    }

    /// The first stage.
    pub fn first_stage(&self) -> &StageDef {
        &self.stages[0]
    }

    /// Next stage slug, or `None` at the end / for an unknown stage (TS: `getNextStage`).
    pub fn next_stage(&self, current: &str) -> Option<&StageDef> {
        let i = self.stage_index(current)?;
        self.stages.get(i + 1)
    }

    /// Previous stage, or `None` at the start / for an unknown stage.
    pub fn previous_stage(&self, current: &str) -> Option<&StageDef> {
        let i = self.stage_index(current)?;
        i.checked_sub(1).map(|p| &self.stages[p])
    }

    /// The narrative connector between `stage` and its successor, if the pipeline has one.
    pub fn connector_after(&self, stage: &str) -> Option<&str> {
        let i = self.stage_index(stage)?;
        self.connectors.get(i).map(String::as_str)
    }

    /// Templates of a stage ordered by `sort_order`.
    pub fn templates_for(&self, stage: &str) -> Vec<&TemplateDef> {
        let mut v: Vec<&TemplateDef> = self.templates.iter().filter(|t| t.stage == stage).collect();
        v.sort_by_key(|t| t.sort_order);
        v
    }

    /// A template by stage and name.
    pub fn template(&self, stage: &str, name: &str) -> Option<&TemplateDef> {
        self.templates
            .iter()
            .find(|t| t.stage == stage && t.name == name)
    }
}

/// A validated set of pipelines (TS: the `LIFECYCLES` map).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registry {
    pipelines: Vec<PipelineDef>,
}

impl Registry {
    /// Build a registry; every pipeline is validated, slugs must be unique, at most one default.
    pub fn new(mut pipelines: Vec<PipelineDef>) -> Result<Self> {
        let mut slugs = HashSet::new();
        let mut defaults = 0;
        for p in &pipelines {
            p.validate()?;
            if !slugs.insert(p.slug.clone()) {
                return Err(Error::Invalid(format!("duplicate pipeline '{}'", p.slug)));
            }
            defaults += usize::from(p.is_default);
        }
        if defaults > 1 {
            return Err(Error::Invalid("more than one default pipeline".into()));
        }
        pipelines.sort_by(|a, b| a.sort_order.cmp(&b.sort_order).then(a.slug.cmp(&b.slug)));
        Ok(Self { pipelines })
    }

    /// Parse and validate pipelines from JSON texts.
    pub fn from_json<'a>(texts: impl IntoIterator<Item = &'a str>) -> Result<Self> {
        let defs = texts
            .into_iter()
            .map(PipelineDef::from_json)
            .collect::<Result<Vec<_>>>()?;
        Self::new(defs)
    }

    /// The pipelines embedded in the binary (`data/pipelines/*.json`).
    ///
    /// # Panics
    /// Panics if an embedded file is invalid; the test suite guarantees they are not.
    #[allow(clippy::expect_used)]
    pub fn builtin() -> &'static Registry {
        static REG: OnceLock<Registry> = OnceLock::new();
        REG.get_or_init(|| {
            Self::from_json(BUILTIN_PIPELINE_FILES.iter().map(|(_, t)| *t))
                .expect("embedded pipelines are valid (checked by tests)")
        })
    }

    /// All pipelines ordered by `sort_order` (TS: `getAllLifecycles`).
    pub fn list(&self) -> &[PipelineDef] {
        &self.pipelines
    }

    /// Pipeline by slug.
    pub fn get(&self, slug: &str) -> Option<&PipelineDef> {
        self.pipelines.iter().find(|p| p.slug == slug)
    }

    /// The default pipeline (flagged, else the slug [`DEFAULT_PIPELINE_SLUG`]).
    pub fn default_pipeline(&self) -> Option<&PipelineDef> {
        self.pipelines
            .iter()
            .find(|p| p.is_default)
            .or_else(|| self.get(DEFAULT_PIPELINE_SLUG))
    }

    /// Pipeline for an optional slug, falling back to the default (TS: `getLifecycle`).
    pub fn resolve(&self, slug: Option<&str>) -> Option<&PipelineDef> {
        slug.filter(|s| !s.is_empty())
            .and_then(|s| self.get(s))
            .or_else(|| self.default_pipeline())
    }

    /// Stage info (TS: `getStageInfo`).
    pub fn stage_info(&self, stage: &str, pipeline: Option<&str>) -> Option<&StageDef> {
        self.resolve(pipeline)?.stage(stage)
    }

    /// Next stage slug (TS: `getNextStage`).
    pub fn next_stage(&self, current: &str, pipeline: Option<&str>) -> Option<&str> {
        self.resolve(pipeline)?
            .next_stage(current)
            .map(|s| s.slug.as_str())
    }

    /// Every template in the registry as `(pipeline, template)`.
    pub fn all_templates(&self) -> impl Iterator<Item = (&PipelineDef, &TemplateDef)> {
        self.pipelines
            .iter()
            .flat_map(|p| p.templates.iter().map(move |t| (p, t)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_embedded_file_loads_and_validates() {
        assert_ne!(BUILTIN_PIPELINE_FILES.len(), 0);
        for (name, text) in BUILTIN_PIPELINE_FILES {
            let def = PipelineDef::from_json(text).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(
                format!("{}.json", def.slug),
                *name,
                "file name must match slug"
            );
        }
    }

    #[test]
    fn builtin_registry_matches_the_ts_seeds() {
        let reg = Registry::builtin();
        assert_eq!(reg.list().len(), 20);
        let def = reg.default_pipeline().unwrap();
        assert_eq!(def.slug, "software_development");
        let slugs: Vec<&str> = def.stages.iter().map(|s| s.slug.as_str()).collect();
        assert_eq!(
            slugs,
            [
                "conception",
                "definition",
                "architecture",
                "implementation",
                "execution"
            ]
        );
        for domain in [
            "hardware_design",
            "contract_law",
            "pharma_documentation",
            "game_design",
        ] {
            assert!(reg.get(domain).is_some(), "{domain}");
        }
        assert_eq!(reg.get("hardware_design").unwrap().stages.len(), 6);
        assert_eq!(
            reg.get("unscripted_video_production").unwrap().stages.len(),
            8
        );
        assert_eq!(reg.list().iter().filter(|p| p.is_default).count(), 1);
        // Every stage of every pipeline has at least two templates.
        for p in reg.list() {
            for s in &p.stages {
                assert!(p.templates_for(&s.slug).len() >= 2, "{}/{}", p.slug, s.slug);
            }
        }
        assert_eq!(reg.all_templates().count(), 260);
    }

    #[test]
    fn helpers_follow_the_ts_registry_semantics() {
        let reg = Registry::builtin();
        assert_eq!(reg.next_stage("conception", None), Some("definition"));
        assert_eq!(reg.next_stage("execution", None), None);
        assert_eq!(reg.next_stage("nope", None), None);
        assert_eq!(
            reg.next_stage("schematic_design", Some("hardware_design")),
            Some("pcb_layout")
        );
        // unknown / empty slug falls back to the default pipeline
        assert_eq!(
            reg.resolve(Some("missing")).unwrap().slug,
            "software_development"
        );
        assert_eq!(reg.resolve(Some("")).unwrap().slug, "software_development");
        assert_eq!(
            reg.stage_info("conception", None).unwrap().abbreviation,
            "CO"
        );
        let sw = reg.default_pipeline().unwrap();
        assert_eq!(
            sw.connector_after("conception"),
            Some("Concept brief seeds the PRD")
        );
        assert_eq!(sw.connector_after("execution"), None);
        assert_eq!(sw.previous_stage("definition").unwrap().slug, "conception");
        assert!(sw.previous_stage("conception").is_none());
        assert_eq!(sw.templates_for("conception")[0].name, "Problem Statement");
    }

    type Mutation = Box<dyn Fn(&mut PipelineDef)>;

    fn sample() -> PipelineDef {
        let stage = |slug: &str, order: i64| StageDef {
            slug: slug.into(),
            sort_order: order,
            label: slug.into(),
            abbreviation: "AA".into(),
            subtitle: String::new(),
            color: String::new(),
            text_color: String::new(),
            dot_color: String::new(),
            border_color: String::new(),
            hex: "#112233".into(),
            who: String::new(),
            description: String::new(),
            icon: String::new(),
            ai: String::new(),
            output: String::new(),
            docs: vec![],
            suggestions: vec![],
        };
        PipelineDef {
            slug: "demo".into(),
            label: "Demo".into(),
            description: String::new(),
            icon: String::new(),
            is_default: false,
            sort_order: 0,
            connectors: vec![],
            stages: vec![stage("one", 0), stage("two", 1)],
            templates: vec![],
        }
    }

    #[test]
    fn validation_rejects_bad_definitions() {
        assert!(sample().validate().is_ok());
        let cases: Vec<(&str, Mutation)> = vec![
            ("slug", Box::new(|p| p.slug = "Bad Slug".into())),
            ("two stages", Box::new(|p| p.stages.truncate(1))),
            (
                "duplicate stage",
                Box::new(|p| p.stages[1].slug = "one".into()),
            ),
            ("hex", Box::new(|p| p.stages[0].hex = "red".into())),
            ("sort_order", Box::new(|p| p.stages[1].sort_order = 0)),
            (
                "connectors",
                Box::new(|p| p.connectors = vec!["a".into(), "b".into()]),
            ),
            (
                "unknown stage",
                Box::new(|p| {
                    p.templates.push(TemplateDef {
                        stage: "ghost".into(),
                        name: "T".into(),
                        description: String::new(),
                        sort_order: 0,
                        content: "# T".into(),
                    });
                }),
            ),
            (
                "bad syntax",
                Box::new(|p| {
                    p.templates.push(TemplateDef {
                        stage: "one".into(),
                        name: "T".into(),
                        description: String::new(),
                        sort_order: 0,
                        content: "# {{oops".into(),
                    });
                }),
            ),
        ];
        for (what, mutate) in cases {
            let mut p = sample();
            mutate(&mut p);
            assert!(matches!(p.validate(), Err(Error::Invalid(_))), "{what}");
        }
    }

    #[test]
    fn registry_rejects_duplicates_and_two_defaults() {
        let mut a = sample();
        a.is_default = true;
        let mut b = sample();
        b.slug = "other".into();
        b.is_default = true;
        assert!(Registry::new(vec![a.clone(), b]).is_err());
        assert!(Registry::new(vec![a.clone(), a]).is_err());
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let mut v = serde_json::to_value(sample()).unwrap();
        v["surprise"] = true.into();
        assert!(PipelineDef::from_json(&v.to_string()).is_err());
    }
}
