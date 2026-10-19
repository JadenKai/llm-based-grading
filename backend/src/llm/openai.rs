//! OpenAI-compatible `/v1/chat/completions` (vLLM, llama.cpp server, LM Studio, OpenRouter…).

use std::collections::BTreeMap;

use eventsource_stream::Eventsource;
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};

use super::think_tags::ThinkSplitter;
use super::{ChatChunk, ChatMessage, ChatRequest, ChunkStream, ModelInfo, Role, ToolCall, send_with_retry};
use crate::config::ThinkSetting;

#[derive(Clone, Debug)]
pub struct OpenAiProvider {
    pub http: reqwest::Client,
    /// Base including the version prefix, e.g. `http://localhost:8000/v1`.
    pub base_url: String,
    pub api_key: Option<String>,
}

#[derive(Deserialize, Default)]
struct DeltaFn {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct DeltaToolCall {
    #[serde(default)]
    index: Option<usize>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<DeltaFn>,
}

#[derive(Deserialize, Default)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    tool_calls: Vec<DeltaToolCall>,
}

#[derive(Deserialize)]
struct Choice {
    #[serde(default)]
    delta: Delta,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    prompt_tokens: Option<u32>,
    #[serde(default)]
    completion_tokens: Option<u32>,
}

#[derive(Deserialize)]
struct Chunk {
    #[serde(default)]
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(Default)]
struct PartialCall {
    id: Option<String>,
    name: String,
    args: String,
}

impl OpenAiProvider {
    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path)
    }

    fn auth(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.api_key {
            Some(k) => rb.bearer_auth(k),
            None => rb,
        }
    }

    pub fn build_body(req: &ChatRequest, with_format: bool) -> Value {
        let mut body = json!({
            "model": req.model,
            "messages": req.messages.iter().map(wire_message).collect::<Vec<_>>(),
            "stream": true,
            "stream_options": {"include_usage": true},
        });
        let p = &req.params;
        if let Some(v) = p.temperature {
            body["temperature"] = json!(v);
        }
        if let Some(v) = p.top_p {
            body["top_p"] = json!(v);
        }
        if let Some(v) = p.top_k {
            body["top_k"] = json!(v);
        }
        if let Some(v) = p.max_tokens {
            body["max_tokens"] = json!(v);
        }
        if let Some(v) = p.seed {
            body["seed"] = json!(v);
        }
        match p.think.unwrap_or_default() {
            ThinkSetting::Low => body["reasoning_effort"] = json!("low"),
            ThinkSetting::Medium => body["reasoning_effort"] = json!("medium"),
            ThinkSetting::High => body["reasoning_effort"] = json!("high"),
            _ => {}
        }
        if !req.tools.is_empty() {
            body["tools"] = req
                .tools
                .iter()
                .map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}}))
                .collect();
        }
        if with_format && let Some(schema) = &req.format {
            body["response_format"] =
                json!({"type": "json_schema", "json_schema": {"name": "output", "schema": schema}});
        }
        body
    }

    pub async fn chat(&self, req: ChatRequest) -> anyhow::Result<ChunkStream> {
        let url = self.url("/chat/completions");
        let body = Self::build_body(&req, true);
        let resp = match send_with_retry(|| self.auth(self.http.post(&url).json(&body))).await {
            Ok(r) => r,
            // Many servers reject `response_format: json_schema`; the prompt still asks for JSON.
            Err(e) if req.format.is_some() && e.to_string().contains("400") => {
                let body = Self::build_body(&req, false);
                send_with_retry(|| self.auth(self.http.post(&url).json(&body))).await?
            }
            Err(e) => return Err(e),
        };
        let mut events = resp.bytes_stream().eventsource();

        let stream = async_stream::try_stream! {
            let mut splitter = ThinkSplitter::default();
            let mut calls: BTreeMap<usize, PartialCall> = BTreeMap::new();
            while let Some(ev) = events.next().await {
                let ev = ev.map_err(|e| anyhow::anyhow!("SSE error: {e}"))?;
                let data = ev.data.trim();
                if data.is_empty() { continue; }
                if data == "[DONE]" { break; }
                let chunk: Chunk = serde_json::from_str(data)
                    .map_err(|e| anyhow::anyhow!("bad chunk ({e}): {data}"))?;
                if let Some(u) = chunk.usage {
                    yield ChatChunk::Usage { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens };
                }
                for choice in chunk.choices {
                    let d = choice.delta;
                    if let Some(r) = d.reasoning_content.or(d.reasoning).filter(|r| !r.is_empty()) {
                        yield ChatChunk::Thinking(r);
                    }
                    if let Some(c) = d.content.filter(|c| !c.is_empty()) {
                        for out in splitter.push(&c) { yield out; }
                    }
                    for tc in d.tool_calls {
                        let idx = tc.index.unwrap_or(calls.len());
                        let entry = calls.entry(idx).or_default();
                        if let Some(id) = tc.id { entry.id = Some(id); }
                        if let Some(f) = tc.function {
                            if let Some(n) = f.name { entry.name.push_str(&n); }
                            if let Some(a) = f.arguments { entry.args.push_str(&a); }
                        }
                    }
                }
            }
            for out in splitter.finish() { yield out; }
            if !calls.is_empty() {
                let calls = calls.into_values().enumerate().map(|(i, c)| ToolCall {
                    id: c.id.unwrap_or_else(|| format!("call_{i}")),
                    name: c.name,
                    arguments: super::json_repair::parse_lenient(&c.args).unwrap_or(json!({})),
                }).collect();
                yield ChatChunk::ToolCalls(calls);
            }
        };
        Ok(stream.boxed())
    }

    pub async fn list_models(&self) -> anyhow::Result<Vec<ModelInfo>> {
        #[derive(Deserialize)]
        struct M {
            id: String,
        }
        #[derive(Deserialize)]
        struct List {
            data: Vec<M>,
        }
        let list: List = self
            .auth(self.http.get(self.url("/models")))
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok(list.data.into_iter().map(|m| ModelInfo { id: m.id, caps: vec!["tools".into()], size: None }).collect())
    }
}

fn wire_message(m: &ChatMessage) -> Value {
    match m.role {
        Role::System => json!({"role": "system", "content": m.content}),
        Role::User => json!({"role": "user", "content": m.content}),
        Role::Assistant => {
            let mut v = json!({"role": "assistant", "content": m.content});
            if !m.tool_calls.is_empty() {
                v["tool_calls"] = m
                    .tool_calls
                    .iter()
                    .map(|c| json!({"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments.to_string()}}))
                    .collect();
            }
            v
        }
        Role::Tool => json!({"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content}),
    }
}
