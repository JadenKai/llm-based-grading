//! Ollama `/api/chat` (NDJSON streaming). Serves both a local daemon and Ollama Cloud
//! (`https://ollama.com` + Bearer key); the wire format is identical.

use futures::StreamExt;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::think_tags::ThinkSplitter;
use super::{ChatChunk, ChatMessage, ChatRequest, ChunkStream, ModelInfo, Role, ToolCall, send_with_retry};
use crate::config::{ModelParams, ThinkSetting};

#[derive(Clone, Debug)]
pub struct OllamaProvider {
    pub http: reqwest::Client,
    pub base_url: String,
    pub api_key: Option<String>,
}

#[derive(Deserialize, Default)]
struct WireToolFn {
    name: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Deserialize)]
struct WireToolCall {
    function: WireToolFn,
}

#[derive(Deserialize, Default)]
struct WireMessage {
    #[serde(default)]
    content: String,
    #[serde(default)]
    thinking: Option<String>,
    #[serde(default)]
    tool_calls: Vec<WireToolCall>,
}

#[derive(Deserialize)]
struct WireChunk {
    #[serde(default)]
    message: Option<WireMessage>,
    #[serde(default)]
    done: bool,
    #[serde(default)]
    prompt_eval_count: Option<u32>,
    #[serde(default)]
    eval_count: Option<u32>,
    #[serde(default)]
    error: Option<String>,
}

impl OllamaProvider {
    pub fn is_cloud(&self) -> bool {
        self.api_key.is_some() && !self.base_url.contains("127.0.0.1") && !self.base_url.contains("localhost")
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path)
    }

    fn auth(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(k) => rb.bearer_auth(k),
            None => rb,
        }
    }

    pub fn build_body(req: &ChatRequest) -> Value {
        let messages: Vec<Value> = req.messages.iter().map(wire_message).collect();
        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            "options": options(&req.params),
        });
        if !req.tools.is_empty() {
            body["tools"] = req
                .tools
                .iter()
                .map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}}))
                .collect();
        }
        if let Some(fmt) = &req.format {
            body["format"] = fmt.clone();
        }
        match req.params.think.unwrap_or_default() {
            ThinkSetting::Default => {}
            ThinkSetting::Off => body["think"] = json!(false),
            ThinkSetting::On => body["think"] = json!(true),
            ThinkSetting::Low => body["think"] = json!("low"),
            ThinkSetting::Medium => body["think"] = json!("medium"),
            ThinkSetting::High => body["think"] = json!("high"),
        }
        body
    }

    pub async fn chat(&self, req: ChatRequest) -> anyhow::Result<ChunkStream> {
        let body = Self::build_body(&req);
        let url = self.url("/api/chat");
        let resp = send_with_retry(|| self.auth(self.http.post(&url).json(&body))).await?;
        let bytes = resp.bytes_stream();

        let stream = async_stream::try_stream! {
            let mut buf: Vec<u8> = Vec::new();
            let mut splitter = ThinkSplitter::default();
            let mut call_idx = 0usize;
            futures::pin_mut!(bytes);
            let mut finished = false;
            while let Some(part) = bytes.next().await {
                buf.extend_from_slice(&part?);
                while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=nl).collect();
                    let line = String::from_utf8_lossy(&line);
                    let line = line.trim();
                    if line.is_empty() { continue; }
                    let chunk: WireChunk = serde_json::from_str(line)
                        .map_err(|e| anyhow::anyhow!("bad Ollama chunk ({e}): {line}"))?;
                    for c in convert(chunk, &mut splitter, &mut call_idx)? {
                        if matches!(c, ChatChunk::Usage { .. }) { finished = true; }
                        yield c;
                    }
                }
            }
            if !buf.is_empty() {
                let line = String::from_utf8_lossy(&buf).trim().to_string();
                if !line.is_empty() {
                    let chunk: WireChunk = serde_json::from_str(&line)?;
                    for c in convert(chunk, &mut splitter, &mut call_idx)? { yield c; }
                }
            }
            if !finished {
                for c in splitter.finish() { yield c; }
            }
        };
        Ok(stream.boxed())
    }

    pub async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>> {
        #[derive(Deserialize)]
        struct Details {
            #[serde(default)]
            parameter_size: Option<String>,
        }
        #[derive(Deserialize)]
        struct Tag {
            name: String,
            #[serde(default)]
            details: Option<Details>,
        }
        #[derive(Deserialize)]
        struct Tags {
            models: Vec<Tag>,
        }
        let resp = self
            .auth(self.http.get(self.url("/api/tags")))
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await?
            .error_for_status()?;
        let tags: Tags = resp.json().await?;
        let shows = tags.models.iter().map(|t| self.capabilities(&t.name));
        let caps = futures::future::join_all(shows).await;
        Ok(tags
            .models
            .into_iter()
            .zip(caps)
            .map(|(t, caps)| ModelInfo {
                id: t.name,
                caps,
                size: t.details.and_then(|d| d.parameter_size).filter(|s| !s.is_empty()),
            })
            .collect())
    }

    async fn capabilities(&self, model: &str) -> Vec<String> {
        #[derive(Deserialize)]
        struct Show {
            #[serde(default)]
            capabilities: Vec<String>,
        }
        let res = self
            .auth(self.http.post(self.url("/api/show")).json(&json!({"model": model})))
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => r
                .json::<Show>()
                .await
                .map(|s| {
                    s.capabilities.into_iter().filter(|c| c == "tools" || c == "thinking" || c == "vision").collect()
                })
                .unwrap_or_default(),
            _ => vec![],
        }
    }
}

fn convert(chunk: WireChunk, splitter: &mut ThinkSplitter, call_idx: &mut usize) -> anyhow::Result<Vec<ChatChunk>> {
    if let Some(err) = chunk.error {
        anyhow::bail!("Ollama error: {err}");
    }
    let mut out = Vec::new();
    if let Some(m) = chunk.message {
        if let Some(t) = m.thinking.filter(|t| !t.is_empty()) {
            out.push(ChatChunk::Thinking(t));
        }
        if !m.content.is_empty() {
            out.extend(splitter.push(&m.content));
        }
        if !m.tool_calls.is_empty() {
            let calls = m
                .tool_calls
                .into_iter()
                .map(|c| {
                    *call_idx += 1;
                    ToolCall {
                        id: format!("call_{}_{}", short_id(), call_idx),
                        name: c.function.name,
                        arguments: normalize_args(c.function.arguments),
                    }
                })
                .collect();
            out.push(ChatChunk::ToolCalls(calls));
        }
    }
    if chunk.done {
        out.extend(splitter.finish());
        out.push(ChatChunk::Usage { prompt_tokens: chunk.prompt_eval_count, completion_tokens: chunk.eval_count });
    }
    Ok(out)
}

/// Some models put a JSON string where an object belongs.
pub fn normalize_args(v: Value) -> Value {
    match v {
        Value::String(s) => super::json_repair::parse_lenient(&s).unwrap_or(Value::Object(Map::new())),
        Value::Null => Value::Object(Map::new()),
        v => v,
    }
}

fn short_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..6].to_string()
}

fn wire_message(m: &ChatMessage) -> Value {
    let role = match m.role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    };
    let mut v = json!({"role": role, "content": m.content});
    if !m.tool_calls.is_empty() {
        // Ollama has no tool-call ids; results are matched by order and `tool_name`.
        v["tool_calls"] =
            m.tool_calls.iter().map(|c| json!({"function": {"name": c.name, "arguments": c.arguments}})).collect();
    }
    if let Some(name) = &m.tool_name
        && m.role == Role::Tool
    {
        v["tool_name"] = json!(name);
    }
    v
}

fn options(p: &ModelParams) -> Value {
    let mut o = Map::new();
    if let Some(v) = p.temperature {
        o.insert("temperature".into(), json!(v));
    }
    if let Some(v) = p.top_p {
        o.insert("top_p".into(), json!(v));
    }
    if let Some(v) = p.top_k {
        o.insert("top_k".into(), json!(v));
    }
    if let Some(v) = p.num_ctx {
        o.insert("num_ctx".into(), json!(v));
    }
    if let Some(v) = p.max_tokens {
        o.insert("num_predict".into(), json!(v));
    }
    if let Some(v) = p.seed {
        o.insert("seed".into(), json!(v));
    }
    Value::Object(o)
}
