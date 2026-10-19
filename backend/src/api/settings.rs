use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{ApiResult, AppError};
use crate::config::SettingsView;
use crate::events::Paragraph;
use crate::grammar::parse_dialect;
use crate::llm::registry::{self, ProviderModels};
use crate::state::Shared;

pub async fn get_settings(State(st): State<Shared>) -> Json<SettingsView> {
    Json(st.settings().view())
}

pub async fn put_settings(State(st): State<Shared>, Json(v): Json<SettingsView>) -> ApiResult<Json<SettingsView>> {
    for e in &v.openai_compat {
        if e.id.is_empty() || e.id.starts_with("ollama-") {
            return Err(AppError::bad_request(format!("invalid endpoint id '{}'", e.id)));
        }
    }
    let updated = {
        let mut s = st.settings.write().unwrap();
        s.apply(v);
        s.clone()
    };
    updated.save(&st.paths.settings)?;
    Ok(Json(updated.view()))
}

pub async fn list_models(State(st): State<Shared>) -> Json<Vec<ProviderModels>> {
    Json(registry::list_all(&st.settings(), &st.http).await)
}

pub async fn test_provider(State(st): State<Shared>, Path(id): Path<String>) -> Json<Value> {
    let settings = st.settings();
    let res = async {
        let p = registry::resolve(&settings, &st.http, &id)?;
        p.list_models().await
    }
    .await;
    Json(match res {
        Ok(models) => json!({"ok": true, "models": models.len()}),
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    })
}

#[derive(Deserialize)]
pub struct GrammarReq {
    paragraphs: Vec<Paragraph>,
}

#[derive(Serialize)]
pub struct GrammarResp {
    issues: Vec<crate::grammar::GrammarIssue>,
}

pub async fn grammar_check(State(st): State<Shared>, Json(req): Json<GrammarReq>) -> ApiResult<Json<GrammarResp>> {
    let g = st.settings().grading;
    let issues = st
        .grammar
        .check(req.paragraphs, parse_dialect(&g.dialect), g.disabled_lint_kinds, g.max_lints_per_paragraph as usize)
        .await?;
    Ok(Json(GrammarResp { issues }))
}
