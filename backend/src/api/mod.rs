mod proposals;
mod runs;
mod sessions;
mod settings;

use axum::extract::DefaultBodyLimit;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde_json::json;

use crate::state::Shared;

pub struct AppError(pub StatusCode, pub String);

impl AppError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, msg.into())
    }
    pub fn not_found(what: &str) -> Self {
        Self(StatusCode::NOT_FOUND, format!("{what} not found"))
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        Self(StatusCode::CONFLICT, msg.into())
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, e.into().to_string())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        if self.0.is_server_error() {
            tracing::error!("{}", self.1);
        }
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}

pub type ApiResult<T> = Result<T, AppError>;

pub fn router(state: Shared) -> Router {
    Router::new()
        .route("/api/health", get(|| async { Json(json!({"ok": true})) }))
        .route("/api/settings", get(settings::get_settings).put(settings::put_settings))
        .route("/api/models", get(settings::list_models))
        .route("/api/providers/{id}/test", post(settings::test_provider))
        .route("/api/grammar", post(settings::grammar_check))
        .route("/api/presets", get(sessions::presets_list))
        .route("/api/sessions", get(sessions::list).post(sessions::create))
        .route("/api/sessions/{id}", get(sessions::get).delete(sessions::delete))
        .route("/api/sessions/{id}/docx", get(sessions::docx).put(sessions::put_docx))
        .route("/api/sessions/{id}/paragraphs", put(sessions::put_paragraphs))
        .route("/api/sessions/{id}/grade", post(runs::grade))
        .route("/api/sessions/{id}/chat", post(runs::chat))
        .route("/api/sessions/{id}/runs/{run_id}/events", get(runs::attach))
        .route("/api/sessions/{id}/runs/{run_id}/cancel", post(runs::cancel))
        .route("/api/sessions/{id}/proposals/{pid}", post(proposals::decide))
        .layer(DefaultBodyLimit::max(25 * 1024 * 1024))
        .with_state(state)
}
