//! Rubrics are JSON documents:
//!
//! ```json
//! { "title": "…", "description": "…",
//!   "criteria": [{ "name": "…", "points": 5, "description": "…",
//!                  "levels": [{ "label": "Exemplary", "points": 5, "description": "…" }] }],
//!   "notes": ["…"] }
//! ```
//!
//! Only `title`, `criteria[].name` and `criteria[].points` are required.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::session::RubricCriterion;

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct RubricLevel {
    pub label: String,
    #[serde(default)]
    pub points: Option<f32>,
    #[serde(default)]
    pub description: String,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Criterion {
    pub name: String,
    pub points: f32,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub levels: Vec<RubricLevel>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Rubric {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub criteria: Vec<Criterion>,
    #[serde(default)]
    pub notes: Vec<String>,
}

impl Rubric {
    /// Parse and validate, with messages a teacher can act on.
    pub fn parse(bytes: &[u8]) -> Result<Rubric, String> {
        let rubric: Rubric =
            serde_json::from_slice(bytes).map_err(|e| format!("the rubric is not valid rubric JSON: {e}"))?;
        if rubric.title.trim().is_empty() {
            return Err("the rubric needs a \"title\"".into());
        }
        if rubric.criteria.is_empty() {
            return Err("the rubric needs at least one entry in \"criteria\"".into());
        }
        for (i, c) in rubric.criteria.iter().enumerate() {
            if c.name.trim().is_empty() {
                return Err(format!("criteria[{i}] needs a \"name\""));
            }
            if !(c.points.is_finite() && c.points > 0.0) {
                return Err(format!("criteria[{i}] (\"{}\") needs \"points\" greater than 0", c.name));
            }
            if rubric.criteria[..i].iter().any(|o| o.name.eq_ignore_ascii_case(&c.name)) {
                return Err(format!("criterion \"{}\" appears twice", c.name));
            }
        }
        Ok(rubric)
    }

    pub fn total(&self) -> f32 {
        self.criteria.iter().map(|c| c.points).sum()
    }

    pub fn criteria_list(&self) -> Vec<RubricCriterion> {
        self.criteria
            .iter()
            .map(|c| RubricCriterion { name: c.name.clone(), max_points: c.points, description: c.description.clone() })
            .collect()
    }

    /// Compact plain-text rendering for prompts.
    pub fn to_text(&self) -> String {
        let fmt = |p: f32| if p.fract() == 0.0 { format!("{p:.0}") } else { format!("{p}") };
        let mut out = format!("{} ({} points)\n", self.title, fmt(self.total()));
        if let Some(d) = self.description.as_deref().filter(|d| !d.trim().is_empty()) {
            out.push_str(d.trim());
            out.push('\n');
        }
        for c in &self.criteria {
            out.push_str(&format!("\n- {} ({} pts)", c.name, fmt(c.points)));
            if !c.description.trim().is_empty() {
                out.push_str(&format!(": {}", c.description.trim()));
            }
            for l in &c.levels {
                let pts = l.points.map(|p| format!(" [{}]", fmt(p))).unwrap_or_default();
                out.push_str(&format!("\n    {}{pts}: {}", l.label, l.description.trim()));
            }
        }
        if !self.notes.is_empty() {
            out.push_str("\n\nNotes:");
            for n in &self.notes {
                out.push_str(&format!("\n- {}", n.trim()));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_and_renders() {
        let r = Rubric::parse(br#"{"title":"T","criteria":[{"name":"Thesis","points":5},{"name":"Evidence","points":2.5,"description":"Accurate.","levels":[{"label":"Full","points":2.5,"description":"All accurate."}]}]}"#).unwrap();
        assert_eq!(r.total(), 7.5);
        let t = r.to_text();
        assert!(t.starts_with("T (7.5 points)"));
        assert!(t.contains("- Evidence (2.5 pts): Accurate.\n    Full [2.5]: All accurate."));
        assert_eq!(r.criteria_list()[0].max_points, 5.0);
    }

    #[test]
    fn rejects_bad_rubrics() {
        assert!(Rubric::parse(b"# markdown").unwrap_err().contains("not valid rubric JSON"));
        assert!(Rubric::parse(br#"{"title":"T","criteria":[]}"#).unwrap_err().contains("at least one"));
        assert!(
            Rubric::parse(br#"{"title":"T","criteria":[{"name":"A","points":0}]}"#)
                .unwrap_err()
                .contains("greater than 0")
        );
        assert!(
            Rubric::parse(br#"{"title":"T","criteria":[{"name":"A","points":1},{"name":"a","points":1}]}"#)
                .unwrap_err()
                .contains("twice")
        );
    }

    #[test]
    fn bundled_rubrics_are_valid() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../examples/rubrics");
        let mut n = 0;
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.extension().is_some_and(|x| x == "json") {
                Rubric::parse(&std::fs::read(&p).unwrap()).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
                n += 1;
            }
        }
        assert!(n >= 1);
    }
}
