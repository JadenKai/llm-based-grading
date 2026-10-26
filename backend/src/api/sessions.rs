use axum::Json;
use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::http::{StatusCode, header};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{ApiResult, AppError};
use crate::events::Paragraph;
use crate::presets::{self, Presets};
use crate::rubric::Rubric;
use crate::session::{Session, SessionSnapshot, SessionSummary};
use crate::state::Shared;

pub fn parse_id(id: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(id).map_err(|_| AppError::not_found("session"))
}

pub async fn list(State(st): State<Shared>) -> Json<Vec<SessionSummary>> {
    let sessions: Vec<_> = st.store.map.iter().map(|e| e.value().clone()).collect();
    let mut out = Vec::new();
    for s in sessions {
        out.push(s.read().await.summary());
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Json(out)
}

#[derive(Serialize)]
pub struct Created {
    session_id: String,
}

/// Multipart: the essay as an uploaded `essay` (.docx) or an `essay_preset` id, and the rubric as an
/// uploaded `rubric` (.json) or a `rubric_preset` id.
pub async fn create(State(st): State<Shared>, mut mp: Multipart) -> ApiResult<Json<Created>> {
    let (mut essay, mut rubric) = (None, None);
    while let Some(field) = mp.next_field().await.map_err(|e| AppError::bad_request(e.to_string()))? {
        let name = field.name().unwrap_or_default().to_string();
        let file_name = field.file_name().unwrap_or_default().to_string();
        let bytes = field.bytes().await.map_err(|e| AppError::bad_request(e.to_string()))?;
        match name.as_str() {
            "essay" => essay = Some((file_name, bytes.to_vec())),
            "rubric" => rubric = Some((file_name, bytes.to_vec())),
            "essay_preset" | "rubric_preset" => {
                let id = String::from_utf8_lossy(&bytes).trim().to_string();
                let kind = if name == "essay_preset" { "essays" } else { "rubrics" };
                let data =
                    presets::read(kind, &id).ok_or_else(|| AppError::bad_request(format!("unknown example '{id}'")))?;
                if kind == "essays" {
                    essay = Some((id, data));
                } else {
                    rubric = Some((id, data));
                }
            }
            _ => {}
        }
    }
    let (essay_name, docx) = essay.ok_or_else(|| AppError::bad_request("choose or upload an essay"))?;
    let (rubric_name, rubric_bytes) = rubric.ok_or_else(|| AppError::bad_request("choose or upload a rubric"))?;
    // .docx is a zip container.
    if !docx.starts_with(b"PK") {
        return Err(AppError::bad_request("the essay must be a .docx file"));
    }
    let rubric = Rubric::parse(&rubric_bytes).map_err(AppError::bad_request)?;
    // Prefer the document's own title over its file name.
    let essay_name = presets::docx_title(&docx).unwrap_or(essay_name);
    let session = Session {
        id: Uuid::new_v4(),
        created_at: chrono::Utc::now().to_rfc3339(),
        essay_name,
        rubric_name,
        rubric_md: rubric.to_text(),
        criteria: rubric.criteria_list(),
        rubric: Some(rubric),
        ..Default::default()
    };
    let id = session.id;
    st.store.create(session, &docx).await?;
    Ok(Json(Created { session_id: id.to_string() }))
}

pub async fn presets_list() -> Json<Presets> {
    Json(presets::list())
}

pub async fn get(State(st): State<Shared>, Path(id): Path<String>) -> ApiResult<Json<SessionSnapshot>> {
    let s = st.store.get(&parse_id(&id)?).ok_or_else(|| AppError::not_found("session"))?;
    let snap = s.read().await.snapshot();
    Ok(Json(snap))
}

pub async fn delete(State(st): State<Shared>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let id = parse_id(&id)?;
    if let Some(s) = st.store.get(&id)
        && let Some(run) = s.read().await.active_run.as_ref().and_then(|r| st.runs.get(r))
    {
        run.cancel.cancel();
    }
    st.store.delete(&id).await;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn docx(State(st): State<Shared>, Path(id): Path<String>) -> ApiResult<Response> {
    let id = parse_id(&id)?;
    if st.store.get(&id).is_none() {
        return Err(AppError::not_found("session"));
    }
    let bytes = tokio::fs::read(st.store.docx_path(&id)).await.map_err(|_| AppError::not_found("document"))?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        .body(Body::from(bytes))
        .unwrap())
}

/// Replace the stored document with the editor's current bytes, so accepted edits survive reloads.
pub async fn put_docx(
    State(st): State<Shared>,
    Path(id): Path<String>,
    body: axum::body::Bytes,
) -> ApiResult<StatusCode> {
    let id = parse_id(&id)?;
    if st.store.get(&id).is_none() {
        return Err(AppError::not_found("session"));
    }
    if !body.starts_with(b"PK") {
        return Err(AppError::bad_request("not a .docx file"));
    }
    let path = st.store.docx_path(&id);
    let tmp = path.with_extension("docx.tmp");
    tokio::fs::write(&tmp, &body).await?;
    tokio::fs::rename(&tmp, &path).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ParagraphsReq {
    paragraphs: Vec<Paragraph>,
}

/// Re-sync paragraph text after the user edits the document; re-anchors annotations.
pub async fn put_paragraphs(
    State(st): State<Shared>,
    Path(id): Path<String>,
    Json(req): Json<ParagraphsReq>,
) -> ApiResult<Json<SessionSnapshot>> {
    let arc = st.store.get(&parse_id(&id)?).ok_or_else(|| AppError::not_found("session"))?;
    let snap = {
        let mut s = arc.write().await;
        if s.paragraphs.is_empty() {
            s.paragraphs = req.paragraphs;
        } else {
            for p in req.paragraphs {
                if s.paragraphs.iter().any(|x| x.key == p.key) {
                    s.update_paragraph_text(&p.key, p.text);
                } else {
                    s.paragraphs.push(p);
                }
            }
        }
        s.snapshot()
    };
    st.store.persist(&arc).await;
    Ok(Json(snap))
}
