//! Provider-neutral chat types plus the provider dispatch.

pub mod json_repair;
pub mod ollama;
pub mod openai;
pub mod registry;
pub mod structured;
#[cfg(test)]
mod tests;
pub mod think_tags;

use std::time::Duration;

use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::config::ModelParams;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ToolCall {
    /// Server-assigned for Ollama (which has no ids), provider id for OpenAI-compatible.
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

impl ChatMessage {
    pub fn new(role: Role, content: impl Into<String>) -> Self {
        Self { role, content: content.into(), thinking: None, tool_calls: vec![], tool_call_id: None, tool_name: None }
    }
    pub fn system(c: impl Into<String>) -> Self {
        Self::new(Role::System, c)
    }
    pub fn user(c: impl Into<String>) -> Self {
        Self::new(Role::User, c)
    }
    pub fn tool(call: &ToolCall, content: impl Into<String>) -> Self {
        Self {
            tool_call_id: Some(call.id.clone()),
            tool_name: Some(call.name.clone()),
            ..Self::new(Role::Tool, content)
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Clone, Debug)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolSpec>,
    /// JSON schema for structured output.
    pub format: Option<Value>,
    pub params: ModelParams,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ChatChunk {
    Thinking(String),
    Text(String),
    ToolCalls(Vec<ToolCall>),
    Usage { prompt_tokens: Option<u32>, completion_tokens: Option<u32> },
}

pub type ChunkStream = BoxStream<'static, anyhow::Result<ChatChunk>>;

#[derive(Serialize, Clone, Debug)]
pub struct ModelInfo {
    pub id: String,
    pub caps: Vec<String>,
    pub size: Option<String>,
}

#[derive(Clone, Debug)]
pub enum Provider {
    Ollama(ollama::OllamaProvider),
    OpenAi(openai::OpenAiProvider),
}

impl Provider {
    pub async fn chat(&self, req: ChatRequest) -> anyhow::Result<ChunkStream> {
        match self {
            Provider::Ollama(p) => p.chat(req).await,
            Provider::OpenAi(p) => p.chat(req).await,
        }
    }

    pub async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>> {
        match self {
            Provider::Ollama(p) => p.list_models().await,
            Provider::OpenAi(p) => p.list_models().await,
        }
    }

    /// Whether this provider talks to a remote service (affects grading concurrency).
    pub fn is_remote(&self) -> bool {
        match self {
            Provider::Ollama(p) => p.is_cloud(),
            Provider::OpenAi(_) => true,
        }
    }
}

/// Send with retry on 429/5xx and connection errors (up to 3 attempts, exponential backoff).
pub async fn send_with_retry(build: impl Fn() -> reqwest::RequestBuilder) -> anyhow::Result<reqwest::Response> {
    let mut delay = Duration::from_millis(800);
    let mut attempt = 0;
    loop {
        attempt += 1;
        match build().send().await {
            Ok(resp) => {
                let st = resp.status();
                if (st.as_u16() == 429 || st.is_server_error()) && attempt < 3 {
                    tracing::warn!("provider returned {st}, retrying in {delay:?}");
                } else if !st.is_success() {
                    let body = resp.text().await.unwrap_or_default();
                    anyhow::bail!("provider returned {st}: {}", truncate(&body, 400));
                } else {
                    return Ok(resp);
                }
            }
            Err(e) if attempt < 3 && (e.is_connect() || e.is_timeout()) => {
                tracing::warn!("provider request failed ({e}), retrying in {delay:?}");
            }
            Err(e) => return Err(e.into()),
        }
        tokio::time::sleep(delay).await;
        delay *= 2;
    }
}

pub fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max_chars).collect();
        out.push_str(" …[truncated]");
        out
    }
}
