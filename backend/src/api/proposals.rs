//! Teacher approval of proposals (grammar fixes and every change the chat agent suggests).

use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::sessions::parse_id;
use super::{ApiResult, AppError};
use crate::events::{Annotation, Paragraph, Proposal, ProposalStatus};
use crate::llm::truncate;
use crate::state::Shared;

#[derive(Deserialize, TS, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Decision {
    Accept,
    Reject,
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct DecisionReq {
    pub decision: Decision,
    #[ts(optional)]
    pub note: Option<String>,
    /// For accepted edits: the paragraph text as the editor has it after applying the edit.
    #[ts(optional)]
    pub paragraph_text: Option<String>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct DecisionResp {
    pub proposals: Vec<Proposal>,
    pub annotations: Vec<Annotation>,
    pub paragraphs: Vec<Paragraph>,
}

fn describe(a: &Annotation) -> String {
    match a {
        Annotation::Score { para, score, .. } => format!("score {para} → {:.0}", score * 100.0),
        Annotation::Comment { para, text, .. } => format!("comment on {para}: \"{}\"", truncate(text, 80)),
        Annotation::Edit { para, anchor, replacement, .. } => {
            format!("edit in {para}: \"{}\" → \"{}\"", truncate(&anchor.quote, 60), truncate(replacement, 60))
        }
    }
}

pub async fn decide(
    State(st): State<Shared>,
    Path((id, pid)): Path<(String, String)>,
    Json(req): Json<DecisionReq>,
) -> ApiResult<Json<DecisionResp>> {
    let arc = st.store.get(&parse_id(&id)?).ok_or_else(|| AppError::not_found("session"))?;
    let resp = {
        let mut s = arc.write().await;
        let idx = s.proposals.iter().position(|p| p.id == pid).ok_or_else(|| AppError::not_found("proposal"))?;
        if s.proposals[idx].status != ProposalStatus::Pending {
            return Err(AppError::conflict(format!(
                "proposal {pid} was already {}",
                format!("{:?}", s.proposals[idx].status).to_lowercase()
            )));
        }
        let note = req.note.filter(|n| !n.trim().is_empty());
        let annotation = s.proposals[idx].annotation.clone();
        let what = describe(&annotation);
        match req.decision {
            Decision::Reject => {
                s.proposals[idx].status = ProposalStatus::Rejected;
                s.proposals[idx].note = note.clone();
            }
            Decision::Accept => {
                s.proposals[idx].status = ProposalStatus::Accepted;
                s.proposals[idx].note = note.clone();
                match &annotation {
                    Annotation::Edit { para, anchor, replacement, .. } => {
                        let new_text = req
                            .paragraph_text
                            .or_else(|| s.apply_edit_text(para, anchor.start, anchor.length, replacement))
                            .ok_or_else(|| AppError::conflict("could not apply the edit to the stored paragraph"))?;
                        s.update_paragraph_text(para, new_text);
                    }
                    _ => s.apply_annotation(annotation.clone()),
                }
            }
        }
        // The chat agent hears about decisions on its own proposals at the start of the next
        // turn. Harper suggestions are left out: bulk-accepting them would flood the context.
        let from_harper = matches!(annotation, Annotation::Edit { source: crate::events::EditSource::Harper, .. });
        if !from_harper {
            let verdict = if req.decision == Decision::Accept { "accepted" } else { "rejected" };
            let note = note.map(|n| format!(" — teacher's note: {n}")).unwrap_or_default();
            s.review_log.push(format!("{pid} {verdict}: {what}{note}"));
        }
        DecisionResp {
            proposals: s.proposals.clone(),
            annotations: s.annotations.clone(),
            paragraphs: s.paragraphs.clone(),
        }
    };
    st.store.persist(&arc).await;
    Ok(Json(resp))
}
