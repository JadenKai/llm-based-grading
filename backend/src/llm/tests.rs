//! Provider stream parsing against recorded wire formats.

use futures::StreamExt;
use serde_json::json;
use wiremock::matchers::{body_partial_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::ollama::OllamaProvider;
use super::openai::OpenAiProvider;
use super::{ChatChunk, ChatMessage, ChatRequest, ToolCall};
use crate::config::{ModelParams, ThinkSetting};

fn req() -> ChatRequest {
    ChatRequest {
        model: "m".into(),
        messages: vec![ChatMessage::user("hi")],
        tools: vec![],
        format: None,
        params: ModelParams { think: Some(ThinkSetting::On), num_ctx: Some(4096), ..Default::default() },
    }
}

async fn collect(s: super::ChunkStream) -> Vec<ChatChunk> {
    s.map(|c| c.unwrap()).collect().await
}

#[tokio::test]
async fn ollama_ndjson_thinking_text_and_tools() {
    let server = MockServer::start().await;
    let body = [
        json!({"message": {"role": "assistant", "content": "", "thinking": "Let me "}, "done": false}),
        json!({"message": {"role": "assistant", "content": "", "thinking": "check."}, "done": false}),
        json!({"message": {"role": "assistant", "content": "", "tool_calls": [
            {"function": {"name": "get_paragraph", "arguments": {"key": "P2"}}},
            {"function": {"name": "check_grammar", "arguments": "{\"keys\":[\"P2\"]}"}}
        ]}, "done": false}),
        json!({"message": {"role": "assistant", "content": "Done"}, "done": false}),
        json!({"message": {"role": "assistant", "content": ""}, "done": true, "prompt_eval_count": 10, "eval_count": 5}),
    ]
    .iter()
    .map(|v| v.to_string())
    .collect::<Vec<_>>()
    .join("\n");
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .and(body_partial_json(json!({"think": true, "options": {"num_ctx": 4096}, "stream": true})))
        .respond_with(ResponseTemplate::new(200).set_body_raw(body, "application/x-ndjson"))
        .mount(&server)
        .await;

    let p = OllamaProvider { http: reqwest::Client::new(), base_url: server.uri(), api_key: None };
    let chunks = collect(p.chat(req()).await.unwrap()).await;

    let thinking: String = chunks
        .iter()
        .filter_map(|c| match c {
            ChatChunk::Thinking(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(thinking, "Let me check.");
    let calls: Vec<&ToolCall> = chunks
        .iter()
        .flat_map(|c| match c {
            ChatChunk::ToolCalls(v) => v.iter().collect(),
            _ => vec![],
        })
        .collect();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].arguments, json!({"key": "P2"}));
    // String-encoded arguments are normalized to an object.
    assert_eq!(calls[1].arguments, json!({"keys": ["P2"]}));
    assert_ne!(calls[0].id, calls[1].id);
    assert!(chunks.contains(&ChatChunk::Text("Done".into())));
    assert!(chunks.contains(&ChatChunk::Usage { prompt_tokens: Some(10), completion_tokens: Some(5) }));
}

#[tokio::test]
async fn ollama_error_line_fails_stream() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(r#"{"error":"model crashed"}"#, "application/x-ndjson"))
        .mount(&server)
        .await;
    let p = OllamaProvider { http: reqwest::Client::new(), base_url: server.uri(), api_key: None };
    let mut s = p.chat(req()).await.unwrap();
    assert!(s.next().await.unwrap().is_err());
}

#[tokio::test]
async fn ollama_cloud_sends_bearer() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/api/chat"))
        .and(wiremock::matchers::header("authorization", "Bearer secret"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_raw(r#"{"message":{"content":"ok"},"done":true}"#, "application/x-ndjson"),
        )
        .mount(&server)
        .await;
    let p = OllamaProvider { http: reqwest::Client::new(), base_url: server.uri(), api_key: Some("secret".into()) };
    let chunks = collect(p.chat(req()).await.unwrap()).await;
    assert!(chunks.contains(&ChatChunk::Text("ok".into())));
}

#[tokio::test]
async fn openai_sse_reasoning_think_tags_and_tool_deltas() {
    let server = MockServer::start().await;
    let events = [
        json!({"choices": [{"delta": {"reasoning_content": "hmm"}}]}),
        json!({"choices": [{"delta": {"content": "<think>inner</think>Hel"}}]}),
        json!({"choices": [{"delta": {"content": "lo"}}]}),
        json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_a", "function": {"name": "web_search", "arguments": "{\"que"}}]}}]}),
        json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "ry\": \"x\"}"}}]}}]}),
        json!({"choices": [], "usage": {"prompt_tokens": 3, "completion_tokens": 4}}),
    ];
    let mut body: String = events.iter().map(|e| format!("data: {e}\n\n")).collect();
    body.push_str("data: [DONE]\n\n");
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(body, "text/event-stream"))
        .mount(&server)
        .await;

    let p = OpenAiProvider { http: reqwest::Client::new(), base_url: format!("{}/v1", server.uri()), api_key: None };
    let chunks = collect(p.chat(req()).await.unwrap()).await;
    let text: String = chunks
        .iter()
        .filter_map(|c| match c {
            ChatChunk::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    let thinking: String = chunks
        .iter()
        .filter_map(|c| match c {
            ChatChunk::Thinking(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "Hello");
    assert_eq!(thinking, "hmminner");
    let calls = chunks
        .iter()
        .find_map(|c| match c {
            ChatChunk::ToolCalls(v) => Some(v.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        calls,
        vec![ToolCall { id: "call_a".into(), name: "web_search".into(), arguments: json!({"query": "x"}) }]
    );
    assert!(chunks.contains(&ChatChunk::Usage { prompt_tokens: Some(3), completion_tokens: Some(4) }));
}

#[test]
fn ollama_history_drops_ids_and_keeps_order() {
    let calls = vec![
        ToolCall { id: "c1".into(), name: "a".into(), arguments: json!({}) },
        ToolCall { id: "c2".into(), name: "b".into(), arguments: json!({"x": 1}) },
    ];
    let mut r = req();
    r.messages.push(ChatMessage { tool_calls: calls.clone(), ..ChatMessage::new(super::Role::Assistant, "") });
    r.messages.push(ChatMessage::tool(&calls[0], "ra"));
    r.messages.push(ChatMessage::tool(&calls[1], "rb"));
    let body = OllamaProvider::build_body(&r);
    let msgs = body["messages"].as_array().unwrap();
    assert_eq!(msgs[1]["tool_calls"][1]["function"]["name"], "b");
    assert_eq!(msgs[2], json!({"role": "tool", "content": "ra", "tool_name": "a"}));
    assert_eq!(msgs[3]["tool_name"], "b");
    assert!(!body.to_string().contains("c1"));
}
