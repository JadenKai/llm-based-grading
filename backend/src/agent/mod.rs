//! Agent runtime: the run context shared by the grading pipeline and the chat loop, plus
//! helpers for streaming model calls and schema-constrained JSON output.

pub mod chat;
pub mod pipeline;
pub mod prompts;
pub mod tools;

use std::sync::Arc;

use futures::StreamExt;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::RwLock;

use crate::config::{ModelParams, ThinkSetting};
use crate::events::{Annotation, Event, ModelRef, Proposal, ProposalStatus, RunKind, StepKind, StepStatus};
use crate::llm::json_repair::parse_lenient;
use crate::llm::{ChatChunk, ChatMessage, ChatRequest, Provider, Role, ToolCall, ToolSpec, structured, truncate};
use crate::session::Session;
use crate::state::{Run, Shared};
use crate::web::WebClient;

#[derive(Clone)]
pub struct RunCtx {
    pub state: Shared,
    pub session: Arc<RwLock<Session>>,
    pub run: Arc<Run>,
    pub provider: Provider,
    pub model: ModelRef,
    pub params: ModelParams,
    pub web: Option<WebClient>,
}

#[derive(Debug, thiserror::Error)]
#[error("run cancelled")]
pub struct Cancelled;

#[derive(Default, Debug)]
pub struct LlmOutput {
    pub text: String,
    pub thinking: String,
    pub tool_calls: Vec<ToolCall>,
}

impl RunCtx {
    pub fn mode(&self) -> RunKind {
        self.run.kind
    }

    pub fn emit(&self, e: Event) {
        self.run.emit(e);
    }

    pub fn check_cancel(&self) -> anyhow::Result<()> {
        if self.run.cancel.is_cancelled() { Err(Cancelled.into()) } else { Ok(()) }
    }

    pub fn step_start(&self, kind: StepKind, label: impl Into<String>, parent: Option<&str>) -> String {
        let step_id = format!("s_{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
        self.emit(Event::StepStarted {
            step_id: step_id.clone(),
            parent_id: parent.map(str::to_string),
            kind,
            label: label.into(),
        });
        step_id
    }

    pub fn step_detail(&self, step_id: &str, detail: impl Into<String>) {
        self.emit(Event::StepUpdated { step_id: step_id.into(), label: None, detail: Some(detail.into()) });
    }

    pub fn step_end(&self, step_id: &str, status: StepStatus, summary: impl Into<String>) {
        let summary = summary.into();
        self.emit(Event::StepFinished {
            step_id: step_id.into(),
            status,
            summary: (!summary.is_empty()).then_some(summary),
        });
    }

    /// Stream one model call. Thinking goes to `thinking_block`, text to `text_message`
    /// (when given), and both are also returned.
    pub async fn stream_llm(
        &self,
        req: ChatRequest,
        thinking_block: &str,
        text_message: Option<&str>,
    ) -> anyhow::Result<LlmOutput> {
        self.check_cancel()?;
        let cancel = self.run.cancel.clone();
        let mut stream = tokio::select! {
            s = self.provider.chat(req) => s?,
            _ = cancel.cancelled() => return Err(Cancelled.into()),
        };
        let mut out = LlmOutput::default();
        loop {
            let next = tokio::select! {
                n = stream.next() => n,
                _ = cancel.cancelled() => return Err(Cancelled.into()),
            };
            let Some(chunk) = next else { break };
            match chunk? {
                ChatChunk::Thinking(t) => {
                    out.thinking.push_str(&t);
                    self.emit(Event::ThinkingDelta { block_id: thinking_block.into(), text: t });
                }
                ChatChunk::Text(t) => {
                    out.text.push_str(&t);
                    if let Some(m) = text_message {
                        self.emit(Event::TextDelta { message_id: m.into(), text: t });
                    }
                }
                ChatChunk::ToolCalls(calls) => out.tool_calls.extend(calls),
                ChatChunk::Usage { prompt_tokens, completion_tokens } => {
                    self.emit(Event::Usage { prompt_tokens, completion_tokens })
                }
            }
        }
        Ok(out)
    }

    /// Ask for a JSON object matching `schema` and deserialize it, retrying once with a
    /// correction message if the reply is not JSON or has the wrong shape.
    ///
    /// The schema is also sent as `format`, but not every server enforces it (Ollama Cloud
    /// ignores it for some models), so the prompt describes the fields in prose: pasting the
    /// raw schema makes some models imitate it and nest the answer under `"properties"`.
    pub async fn complete_json<T: DeserializeOwned>(
        &self,
        system: &str,
        user: &str,
        schema: Value,
        step_id: &str,
    ) -> anyhow::Result<T> {
        let mut params = self.params.clone();
        // Structured calls are extraction-like: keep them cool, and keep reasoning modest.
        params.temperature = Some(params.temperature.unwrap_or(0.2).min(0.3));
        if matches!(params.think, Some(ThinkSetting::High)) {
            params.think = Some(ThinkSetting::Medium);
        }
        let required = structured::required_keys(&schema);
        let system = format!(
            "{system}\n{}\n\nReply with ONLY a JSON object — no Markdown, no code fences, no other text — whose top-level \
keys are:\n{}",
            prompts::BREVITY,
            structured::describe(&schema)
        );
        let mut messages = vec![ChatMessage::system(system), ChatMessage::user(user)];
        let mut last_err = None;
        for attempt in 0..2 {
            let req = ChatRequest {
                model: self.model.model.clone(),
                messages: messages.clone(),
                tools: vec![],
                format: Some(schema.clone()),
                params: params.clone(),
            };
            let out = self.stream_llm(req, step_id, None).await?;
            let result = match parse_lenient(&out.text) {
                None => Err(anyhow::anyhow!("the reply was not JSON")),
                Some(v) => serde_json::from_value::<T>(structured::unwrap_nested(v, &required))
                    .map_err(|e| anyhow::anyhow!("the reply had the wrong fields ({e})")),
            };
            match result {
                Ok(t) => return Ok(t),
                Err(e) => {
                    tracing::warn!(
                        "structured output attempt {attempt} failed: {e}; reply: {}",
                        truncate(&out.text, 300)
                    );
                    if attempt == 0 {
                        self.step_detail(step_id, "Reply didn't match the expected format — retrying");
                    }
                    messages.push(ChatMessage::new(Role::Assistant, out.text));
                    messages.push(ChatMessage::user(format!(
                        "Invalid: {e}. Reply again with ONLY a JSON object whose top-level keys are: {}.",
                        required.join(", ")
                    )));
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("structured output failed")))
    }

    /// Record an annotation: applied directly while grading, a pending proposal in chat.
    pub async fn annotate(&self, annotation: Annotation) -> String {
        let mut s = self.session.write().await;
        match self.mode() {
            RunKind::Grade => {
                let id = annotation.id().to_string();
                s.apply_annotation(annotation.clone());
                drop(s);
                self.emit(Event::AnnotationApplied { annotation });
                id
            }
            RunKind::Chat => {
                let pid = s.next_id("p");
                let proposal = Proposal { id: pid.clone(), annotation, status: ProposalStatus::Pending, note: None };
                s.proposals.push(proposal.clone());
                drop(s);
                self.emit(Event::ProposalCreated { proposal });
                pid
            }
        }
    }

    pub fn tool_specs_enabled(&self) -> Vec<ToolSpec> {
        tools::specs(self.web.is_some())
    }
}

pub fn is_cancelled(e: &anyhow::Error) -> bool {
    e.downcast_ref::<Cancelled>().is_some()
}
