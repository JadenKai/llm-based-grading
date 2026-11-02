//! The instructor's score overrides for the final assessment. The model's original
//! assessment stays frozen; overrides are kept alongside it.

use axum::Json;
use axum::extract::{Path, State};
use serde::Deserialize;
use ts_rs::TS;

use super::sessions::parse_id;
use super::{ApiResult, AppError};
use crate::session::ScoreOverride;
use crate::state::Shared;

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct OverrideReq {
    pub criterion: String,
    /// New score; `null` removes the override (back to the model's score).
    pub score: Option<f32>,
    #[ts(optional)]
    pub note: Option<String>,
}

pub async fn set(
    State(st): State<Shared>,
    Path(id): Path<String>,
    Json(req): Json<OverrideReq>,
) -> ApiResult<Json<Vec<ScoreOverride>>> {
    let arc = st.store.get(&parse_id(&id)?).ok_or_else(|| AppError::not_found("session"))?;
    let out = {
        let mut s = arc.write().await;
        let a =
            s.original_assessment.as_ref().ok_or_else(|| AppError::conflict("the essay has not been graded yet"))?;
        let c = a
            .criteria
            .iter()
            .find(|c| c.name == req.criterion)
            .ok_or_else(|| AppError::bad_request(format!("unknown criterion \"{}\"", req.criterion)))?;
        let max = c.max;
        s.score_overrides.retain(|o| o.criterion != req.criterion);
        if let Some(score) = req.score {
            if !score.is_finite() || score < 0.0 || score > max {
                return Err(AppError::bad_request(format!("the score must be between 0 and {max}")));
            }
            s.score_overrides.push(ScoreOverride {
                criterion: req.criterion,
                score,
                note: req.note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()),
                updated_at: chrono::Utc::now().to_rfc3339(),
            });
        }
        s.score_overrides.clone()
    };
    st.store.persist(&arc).await;
    Ok(Json(out))
}
