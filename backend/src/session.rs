//! Grading sessions: uploaded essay + rubric, annotations, proposals, agent history.
//! Kept in memory and mirrored to `<data>/sessions/<id>.json` (+ `.docx`).

use std::path::PathBuf;
use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::RwLock;
use ts_rs::TS;
use uuid::Uuid;

use crate::events::{Annotation, Assessment, Envelope, ModelRef, Paragraph, Proposal, ProposalStatus};
use crate::llm::ChatMessage;
use crate::rubric::Rubric;
use crate::text::{find_anchor, slice_utf16, utf16_prefix};

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct RubricCriterion {
    pub name: String,
    pub max_points: f32,
    pub description: String,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct FactCheck {
    pub para: String,
    pub claim: String,
    pub verdict: String,
    pub explanation: String,
    pub source_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Session {
    pub id: Uuid,
    pub created_at: String,
    pub essay_name: String,
    pub rubric_name: String,
    /// Rubric as text for prompts (rendered from `rubric`; Markdown in sessions from before JSON rubrics).
    pub rubric_md: String,
    pub rubric: Option<Rubric>,
    pub paragraphs: Vec<Paragraph>,
    pub annotations: Vec<Annotation>,
    pub proposals: Vec<Proposal>,
    pub thesis: Option<String>,
    pub criteria: Vec<RubricCriterion>,
    pub fact_checks: Vec<FactCheck>,
    pub original_assessment: Option<Assessment>,
    pub graded: bool,
    pub model: Option<ModelRef>,
    pub history: Vec<ChatMessage>,
    pub transcript: Vec<Envelope>,
    pub review_log: Vec<String>,
    pub active_run: Option<String>,
    pub next_id: u64,
}

#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct SessionSnapshot {
    pub id: String,
    pub created_at: String,
    pub essay_name: String,
    pub rubric_name: String,
    /// Rubric as text for prompts (rendered from `rubric`; Markdown in sessions from before JSON rubrics).
    pub rubric_md: String,
    pub rubric: Option<Rubric>,
    pub paragraphs: Vec<Paragraph>,
    pub annotations: Vec<Annotation>,
    pub proposals: Vec<Proposal>,
    pub thesis: Option<String>,
    pub criteria: Vec<RubricCriterion>,
    pub fact_checks: Vec<FactCheck>,
    pub original_assessment: Option<Assessment>,
    pub graded: bool,
    pub model: Option<ModelRef>,
    /// Every event of finished runs, for replaying the chat.
    pub transcript: Vec<Value>,
    pub active_run: Option<String>,
}

#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct SessionSummary {
    pub id: String,
    pub created_at: String,
    pub essay_name: String,
    pub graded: bool,
    pub overall: Option<f32>,
    pub max: Option<f32>,
}

impl Session {
    pub fn next_id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}{}", self.next_id)
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            id: self.id.to_string(),
            created_at: self.created_at.clone(),
            essay_name: self.essay_name.clone(),
            rubric_name: self.rubric_name.clone(),
            rubric_md: self.rubric_md.clone(),
            rubric: self.rubric.clone(),
            paragraphs: self.paragraphs.clone(),
            annotations: self.annotations.clone(),
            proposals: self.proposals.clone(),
            thesis: self.thesis.clone(),
            criteria: self.criteria.clone(),
            fact_checks: self.fact_checks.clone(),
            original_assessment: self.original_assessment.clone(),
            graded: self.graded,
            model: self.model.clone(),
            transcript: self.transcript.iter().filter_map(|e| serde_json::to_value(e).ok()).collect(),
            active_run: self.active_run.clone(),
        }
    }

    pub fn summary(&self) -> SessionSummary {
        SessionSummary {
            id: self.id.to_string(),
            created_at: self.created_at.clone(),
            essay_name: self.essay_name.clone(),
            graded: self.graded,
            overall: self.original_assessment.as_ref().map(|a| a.overall),
            max: self.original_assessment.as_ref().map(|a| a.max),
        }
    }

    pub fn paragraph(&self, key: &str) -> Option<&Paragraph> {
        self.paragraphs.iter().find(|p| p.key.eq_ignore_ascii_case(key.trim()))
    }

    pub fn score_of(&self, key: &str) -> Option<f32> {
        self.annotations.iter().find_map(|a| match a {
            Annotation::Score { para, score, .. } if para == key => Some(*score),
            _ => None,
        })
    }

    /// Apply an accepted annotation to the session state.
    pub fn apply_annotation(&mut self, ann: Annotation) {
        if let Annotation::Score { para, .. } = &ann {
            let para = para.clone();
            self.annotations.retain(|a| !matches!(a, Annotation::Score { para: p, .. } if *p == para));
        }
        self.annotations.push(ann);
    }

    /// Replace a paragraph's text and re-anchor everything that points into it.
    pub fn update_paragraph_text(&mut self, key: &str, new_text: String) {
        let Some(p) = self.paragraphs.iter_mut().find(|p| p.key == key) else { return };
        if p.text == new_text {
            return;
        }
        p.text = new_text.clone();
        for prop in self.proposals.iter_mut().filter(|p| p.status == ProposalStatus::Pending) {
            if prop.annotation.para() != key {
                continue;
            }
            match &mut prop.annotation {
                Annotation::Edit { anchor, .. } => match find_anchor(&new_text, &anchor.quote, Some(anchor.start)) {
                    Some(a) if a.quote == anchor.quote => *anchor = a,
                    _ => prop.status = ProposalStatus::Stale,
                },
                Annotation::Comment { anchor, .. } => {
                    if let Some(a) = anchor.as_ref() {
                        *anchor = find_anchor(&new_text, &a.quote, Some(a.start));
                    }
                }
                Annotation::Score { .. } => {}
            }
        }
        for ann in self.annotations.iter_mut() {
            if let Annotation::Comment { para, anchor, .. } = ann
                && para == key
                && let Some(a) = anchor.take()
            {
                *anchor = find_anchor(&new_text, &a.quote, Some(a.start));
            }
        }
    }

    /// Apply an edit to the stored paragraph text (used when the client did not send the
    /// post-edit text). Returns the new text.
    pub fn apply_edit_text(&self, key: &str, start: u32, length: u32, replacement: &str) -> Option<String> {
        let p = self.paragraph(key)?;
        let total = *utf16_prefix(&p.text).last()?;
        let before = slice_utf16(&p.text, 0, start)?;
        let after = slice_utf16(&p.text, start + length, total.checked_sub(start + length)?)?;
        Some(format!("{before}{replacement}{after}"))
    }
}

pub struct Store {
    dir: PathBuf,
    pub map: DashMap<Uuid, Arc<RwLock<Session>>>,
}

impl Store {
    pub fn open(dir: PathBuf) -> Store {
        let map = DashMap::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let path = e.path();
                if path.extension().is_some_and(|x| x == "json") {
                    match std::fs::read(&path).map(|b| serde_json::from_slice::<Session>(&b)) {
                        Ok(Ok(mut s)) => {
                            // A run cannot survive a restart.
                            s.active_run = None;
                            map.insert(s.id, Arc::new(RwLock::new(s)));
                        }
                        _ => tracing::warn!("skipping unreadable session {}", path.display()),
                    }
                }
            }
        }
        tracing::info!("loaded {} sessions from {}", map.len(), dir.display());
        Store { dir, map }
    }

    pub fn get(&self, id: &Uuid) -> Option<Arc<RwLock<Session>>> {
        self.map.get(id).map(|s| s.clone())
    }

    pub fn docx_path(&self, id: &Uuid) -> PathBuf {
        self.dir.join(format!("{id}.docx"))
    }

    pub async fn create(&self, session: Session, docx: &[u8]) -> anyhow::Result<Arc<RwLock<Session>>> {
        tokio::fs::create_dir_all(&self.dir).await?;
        tokio::fs::write(self.docx_path(&session.id), docx).await?;
        let id = session.id;
        let arc = Arc::new(RwLock::new(session));
        self.map.insert(id, arc.clone());
        self.persist(&arc).await;
        Ok(arc)
    }

    pub async fn persist(&self, session: &Arc<RwLock<Session>>) {
        let (id, bytes) = {
            let s = session.read().await;
            (s.id, serde_json::to_vec(&*s))
        };
        let result = async {
            let bytes = bytes?;
            tokio::fs::create_dir_all(&self.dir).await?;
            let path = self.dir.join(format!("{id}.json"));
            let tmp = path.with_extension("json.tmp");
            tokio::fs::write(&tmp, bytes).await?;
            tokio::fs::rename(&tmp, &path).await?;
            anyhow::Ok(())
        }
        .await;
        if let Err(e) = result {
            tracing::error!("failed to persist session {id}: {e}");
        }
    }

    pub async fn delete(&self, id: &Uuid) {
        self.map.remove(id);
        let _ = tokio::fs::remove_file(self.dir.join(format!("{id}.json"))).await;
        let _ = tokio::fs::remove_file(self.docx_path(id)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{Anchor, EditSource};

    fn edit(id: &str, start: u32, quote: &str) -> Proposal {
        Proposal {
            id: id.into(),
            status: ProposalStatus::Pending,
            note: None,
            annotation: Annotation::Edit {
                id: id.into(),
                para: "P1".into(),
                anchor: Anchor { start, length: quote.encode_utf16().count() as u32, quote: quote.into() },
                replacement: "x".into(),
                reason: String::new(),
                source: EditSource::Harper,
                lint_kind: None,
            },
        }
    }

    #[test]
    fn reanchors_and_marks_stale() {
        let mut s = Session {
            paragraphs: vec![Paragraph { key: "P1".into(), index: 0, text: "teh cat sat on teh mat".into() }],
            proposals: vec![edit("a", 0, "teh"), edit("b", 15, "teh"), edit("c", 8, "sat")],
            ..Default::default()
        };
        let new = s.apply_edit_text("P1", 0, 3, "the").unwrap();
        assert_eq!(new, "the cat sat on teh mat");
        s.proposals[0].status = ProposalStatus::Accepted;
        s.update_paragraph_text("P1", "the cat sat on teh mat".into());
        match &s.proposals[1].annotation {
            Annotation::Edit { anchor, .. } => assert_eq!(anchor.start, 15),
            _ => unreachable!(),
        }
        s.update_paragraph_text("P1", "the cat stood on teh mat".into());
        assert_eq!(s.proposals[2].status, ProposalStatus::Stale);
        match &s.proposals[1].annotation {
            Annotation::Edit { anchor, .. } => assert_eq!(anchor.start, 17),
            _ => unreachable!(),
        }
    }
}
