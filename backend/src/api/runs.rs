//! Starting runs (grading, chat) and streaming their events over SSE.

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures::Stream;
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;

use super::sessions::parse_id;
use super::{ApiResult, AppError};
use crate::agent::{self, RunCtx, is_cancelled};
use crate::config::ThinkSetting;
use crate::events::{Envelope, Event, ModelRef, Paragraph, RunKind, RunStatus};
use crate::llm::registry;
use crate::state::{Run, Shared};
use crate::web::WebClient;

enum Job {
    Grade,
    Chat(String),
}

#[derive(Deserialize)]
pub struct GradeReq {
    paragraphs: Vec<Paragraph>,
    model: ModelRef,
}

pub async fn grade(State(st): State<Shared>, Path(id): Path<String>, Json(req): Json<GradeReq>) -> ApiResult<Response> {
    let sid = parse_id(&id)?;
    let arc = st.store.get(&sid).ok_or_else(|| AppError::not_found("session"))?;
    {
        let mut s = arc.write().await;
        if s.original_assessment.is_some() {
            return Err(AppError::conflict("this essay has already been graded"));
        }
        if req.paragraphs.iter().all(|p| p.text.trim().is_empty()) {
            return Err(AppError::bad_request("the document has no text"));
        }
        if s.active_run.is_none() {
            // Fresh (or retried) grading starts from a clean slate.
            s.paragraphs = req.paragraphs;
            s.annotations.clear();
            s.proposals.clear();
            s.fact_checks.clear();
        }
    }
    let run = start(&st, sid, req.model, None, Job::Grade).await?;
    Ok(sse(run))
}

#[derive(Deserialize)]
pub struct ChatReq {
    message: String,
    model: ModelRef,
    #[serde(default)]
    think: Option<ThinkSetting>,
}

pub async fn chat(State(st): State<Shared>, Path(id): Path<String>, Json(req): Json<ChatReq>) -> ApiResult<Response> {
    let sid = parse_id(&id)?;
    if req.message.trim().is_empty() {
        return Err(AppError::bad_request("empty message"));
    }
    let run = start(&st, sid, req.model, req.think, Job::Chat(req.message)).await?;
    Ok(sse(run))
}

pub async fn attach(State(st): State<Shared>, Path((_id, run_id)): Path<(String, String)>) -> ApiResult<Response> {
    let run = st.runs.get(&run_id).map(|r| r.clone()).ok_or_else(|| AppError::not_found("run"))?;
    Ok(sse(run))
}

pub async fn cancel(State(st): State<Shared>, Path((_id, run_id)): Path<(String, String)>) -> StatusCode {
    match st.runs.get(&run_id) {
        Some(run) => {
            run.cancel.cancel();
            StatusCode::NO_CONTENT
        }
        None => StatusCode::NOT_FOUND,
    }
}

async fn start(
    st: &Shared,
    sid: uuid::Uuid,
    model: ModelRef,
    think: Option<ThinkSetting>,
    job: Job,
) -> ApiResult<Arc<Run>> {
    let arc = st.store.get(&sid).ok_or_else(|| AppError::not_found("session"))?;
    let settings = st.settings();
    let provider =
        registry::resolve(&settings, &st.http, &model.provider_id).map_err(|e| AppError::bad_request(e.to_string()))?;
    let mut params = settings.params_for(&model);
    if think.is_some() {
        params.think = think;
    }
    let web = settings.ollama_key().map(|api_key| WebClient {
        http: st.http.clone(),
        base_url: settings.ollama_cloud.base_url.clone(),
        api_key,
    });
    let kind = match job {
        Job::Grade => RunKind::Grade,
        Job::Chat(_) => RunKind::Chat,
    };

    let run = Run::new(kind);
    {
        let mut s = arc.write().await;
        if let Some(active) = &s.active_run
            && st.runs.contains_key(active)
        {
            return Err(AppError::conflict("another run is in progress for this essay"));
        }
        s.active_run = Some(run.id.clone());
        s.model = Some(model.clone());
    }
    st.runs.insert(run.id.clone(), run.clone());
    run.emit(Event::RunStarted { kind, model: model.clone() });
    if let Job::Chat(text) = &job {
        run.emit(Event::UserMessage { text: text.clone() });
    }

    let ctx = RunCtx { state: st.clone(), session: arc.clone(), run: run.clone(), provider, model, params, web };
    let st2 = st.clone();
    tokio::spawn(async move {
        let result = match job {
            Job::Grade => agent::pipeline::run_grading(&ctx).await,
            Job::Chat(text) => agent::chat::run_chat(&ctx, text).await,
        };
        let status = match result {
            Ok(()) => RunStatus::Completed,
            Err(e) if is_cancelled(&e) => RunStatus::Cancelled,
            Err(e) => {
                tracing::warn!("run {} failed: {e:#}", ctx.run.id);
                ctx.emit(Event::Error { message: format!("{e:#}"), recoverable: false });
                RunStatus::Failed
            }
        };
        ctx.emit(Event::RunFinished { status });
        {
            let mut s = ctx.session.write().await;
            s.transcript.extend(ctx.run.events());
            s.active_run = None;
        }
        st2.store.persist(&ctx.session).await;
        // Keep the run around briefly so a reloading client can still attach and drain it.
        let run_id = ctx.run.id.clone();
        tokio::time::sleep(Duration::from_secs(30)).await;
        st2.runs.remove(&run_id);
    });
    Ok(run)
}

fn to_sse(env: &Envelope) -> SseEvent {
    SseEvent::default().data(serde_json::to_string(env).unwrap_or_else(|_| "{}".into()))
}

fn event_stream(run: Arc<Run>) -> impl Stream<Item = Result<SseEvent, Infallible>> {
    let (backlog, rx) = run.subscribe();
    async_stream::stream! {
        for env in backlog {
            let done = matches!(env.event, Event::RunFinished { .. });
            yield Ok(to_sse(&env));
            if done { return; }
        }
        let Some(mut rx) = rx else { return };
        loop {
            match rx.recv().await {
                Ok(env) => {
                    let done = matches!(env.event, Event::RunFinished { .. });
                    yield Ok(to_sse(&env));
                    if done { return; }
                }
                Err(RecvError::Lagged(n)) => tracing::warn!("SSE client lagged by {n} events"),
                Err(RecvError::Closed) => return,
            }
        }
    }
}

fn sse(run: Arc<Run>) -> Response {
    let mut resp =
        Sse::new(event_stream(run)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))).into_response();
    let h = resp.headers_mut();
    h.insert("X-Accel-Buffering", HeaderValue::from_static("no"));
    h.insert("Cache-Control", HeaderValue::from_static("no-cache"));
    resp
}
