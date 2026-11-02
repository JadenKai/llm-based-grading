//! Instructor comments: written by the teacher, applied immediately (no proposal), and kept
//! apart from the model's comments.

use axum::Json;
use axum::extract::{Path, State};
use serde::Deserialize;
use ts_rs::TS;

use super::proposals::DecisionResp;
use super::sessions::parse_id;
use super::{ApiResult, AppError};
use crate::events::{Annotation, CommentAuthor};
use crate::session::Session;
use crate::state::Shared;
use crate::text::resolve_quote;

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct NewComment {
    pub para: String,
    /// Selected text to anchor to; the whole paragraph when absent or not found.
    #[ts(optional)]
    pub quote: Option<String>,
    pub text: String,
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct CommentEdit {
    pub text: String,
}

fn resp(s: &Session) -> DecisionResp {
    DecisionResp {
        proposals: s.proposals.clone(),
        annotations: s.annotations.clone(),
        paragraphs: s.paragraphs.clone(),
    }
}

pub async fn add(
    State(st): State<Shared>,
    Path(id): Path<String>,
    Json(req): Json<NewComment>,
) -> ApiResult<Json<DecisionResp>> {
    let arc = st.store.get(&parse_id(&id)?).ok_or_else(|| AppError::not_found("session"))?;
    let text = req.text.trim().to_string();
    if text.is_empty() {
        return Err(AppError::bad_request("the comment is empty"));
    }
    let out = {
        let mut s = arc.write().await;
        let p = s.paragraph(&req.para).ok_or_else(|| AppError::not_found("paragraph"))?;
        let (para, anchor) =
            (p.key.clone(), resolve_quote(&p.text, req.quote.as_deref().filter(|q| !q.trim().is_empty())));
        let ann_id = s.next_id("i");
        s.annotations.push(Annotation::Comment { id: ann_id, para, anchor, text, author: CommentAuthor::Instructor });
        resp(&s)
    };
    st.store.persist(&arc).await;
    Ok(Json(out))
}

fn instructor_comment<'a>(s: &'a mut Session, ann_id: &str) -> ApiResult<&'a mut Annotation> {
    s.annotations
        .iter_mut()
        .find(|a| a.id() == ann_id)
        .filter(|a| matches!(a, Annotation::Comment { author: CommentAuthor::Instructor, .. }))
        .ok_or_else(|| AppError::not_found("instructor comment"))
}

pub async fn update(
    State(st): State<Shared>,
    Path((id, ann_id)): Path<(String, String)>,
    Json(req): Json<CommentEdit>,
) -> ApiResult<Json<DecisionResp>> {
    let arc = st.store.get(&parse_id(&id)?).ok_or_else(|| AppError::not_found("session"))?;
    let new_text = req.text.trim().to_string();
    if new_text.is_empty() {
        return Err(AppError::bad_request("the comment is empty"));
    }
    let out = {
        let mut s = arc.write().await;
        if let Annotation::Comment { text, .. } = instructor_comment(&mut s, &ann_id)? {
            *text = new_text;
        }
        resp(&s)
    };
    st.store.persist(&arc).await;
    Ok(Json(out))
}

pub async fn delete(
    State(st): State<Shared>,
    Path((id, ann_id)): Path<(String, String)>,
) -> ApiResult<Json<DecisionResp>> {
    let arc = st.store.get(&parse_id(&id)?).ok_or_else(|| AppError::not_found("session"))?;
    let out = {
        let mut s = arc.write().await;
        instructor_comment(&mut s, &ann_id)?;
        s.annotations.retain(|a| a.id() != ann_id);
        resp(&s)
    };
    st.store.persist(&arc).await;
    Ok(Json(out))
}
