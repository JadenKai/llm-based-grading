//! Tools exposed to the chat agent.

use serde::Deserialize;
use serde_json::{Value, json};

use super::RunCtx;
use super::prompts::{comments_for, paragraph_index};
use crate::events::{Anchor, Annotation, CommentAuthor, EditSource, StepKind};
use crate::grammar::parse_dialect;
use crate::llm::{ToolCall, ToolSpec, truncate};
use crate::text::{find_anchor, resolve_quote};

const MAX_RESULT_CHARS: usize = 6000;

pub struct ToolOutcome {
    pub ok: bool,
    /// Short human-readable summary for the UI.
    pub summary: String,
    /// What the model sees.
    pub content: String,
    pub data: Option<Value>,
}

impl ToolOutcome {
    fn ok(summary: impl Into<String>, content: impl Into<String>) -> Self {
        Self { ok: true, summary: summary.into(), content: content.into(), data: None }
    }
    fn err(msg: impl Into<String>) -> Self {
        let msg = msg.into();
        Self { ok: false, summary: msg.clone(), content: format!("Error: {msg}"), data: None }
    }
    fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

fn spec(name: &str, description: &str, parameters: Value) -> ToolSpec {
    ToolSpec { name: name.into(), description: description.into(), parameters }
}

pub fn specs(web: bool) -> Vec<ToolSpec> {
    let key = json!({"type": "string", "description": "Paragraph key, e.g. \"P3\""});
    let mut v = vec![
        spec("get_rubric", "Return the full grading rubric (Markdown).", json!({"type": "object", "properties": {}})),
        spec(
            "list_paragraphs",
            "List every paragraph with its key, current score (0-100) and opening words.",
            json!({"type": "object", "properties": {}}),
        ),
        spec(
            "get_paragraph",
            "Return the full text of one paragraph, its score, rationale and existing comments.",
            json!({"type": "object", "properties": {"key": key}, "required": ["key"]}),
        ),
        spec(
            "get_assessment",
            "Return the original rubric assessment (per-criterion scores and justifications).",
            json!({"type": "object", "properties": {}}),
        ),
        spec(
            "check_grammar",
            "Run the Harper grammar checker on some paragraphs (or all if keys is omitted). Returns issues with suggested fixes.",
            json!({"type": "object", "properties": {"keys": {"type": "array", "items": {"type": "string"}}}}),
        ),
        spec(
            "list_proposals",
            "List proposals you have made and their review status (pending/accepted/rejected/stale).",
            json!({"type": "object", "properties": {}}),
        ),
        spec(
            "set_paragraph_score",
            "PROPOSE a new score (0-100) for how well a paragraph supports the thesis. Requires teacher approval.",
            json!({"type": "object", "properties": {
                "key": key,
                "score": {"type": "integer", "minimum": 0, "maximum": 100},
                "rationale": {"type": "string"}
            }, "required": ["key", "score", "rationale"]}),
        ),
        spec(
            "add_comment",
            "PROPOSE a comment on a paragraph, optionally anchored to an exact quote from it. Requires teacher approval.",
            json!({"type": "object", "properties": {
                "key": key,
                "quote": {"type": "string", "description": "Exact text from the paragraph to anchor to (optional)"},
                "text": {"type": "string"}
            }, "required": ["key", "text"]}),
        ),
        spec(
            "propose_edit",
            "PROPOSE replacing exact text in a paragraph (e.g. a grammar fix). Requires teacher approval.",
            json!({"type": "object", "properties": {
                "key": key,
                "original": {"type": "string", "description": "Exact text currently in the paragraph"},
                "replacement": {"type": "string"},
                "reason": {"type": "string"}
            }, "required": ["key", "original", "replacement", "reason"]}),
        ),
    ];
    if web {
        v.push(spec(
            "web_search",
            "Search the web to fact-check a claim. Returns titles, URLs and snippets.",
            json!({"type": "object", "properties": {
                "query": {"type": "string"},
                "max_results": {"type": "integer", "minimum": 1, "maximum": 10}
            }, "required": ["query"]}),
        ));
        v.push(spec(
            "web_fetch",
            "Fetch a web page's main text content.",
            json!({"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}),
        ));
    }
    v
}

/// Step label and kind shown in the chat while a tool runs.
pub fn describe(call: &ToolCall) -> (StepKind, String) {
    let a = &call.arguments;
    let s = |k: &str| a.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match call.name.as_str() {
        "get_rubric" => (StepKind::ReadRubric, "Reading rubric".into()),
        "list_paragraphs" => (StepKind::Tool, "Listing paragraphs".into()),
        "get_paragraph" => (StepKind::Tool, format!("Reading paragraph {}", s("key"))),
        "get_assessment" => (StepKind::Assessment, "Reading original assessment".into()),
        "check_grammar" => {
            let keys = a
                .get("keys")
                .and_then(Value::as_array)
                .map(|k| k.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "));
            (
                StepKind::Grammar,
                match keys.filter(|k| !k.is_empty()) {
                    Some(k) => format!("Checking grammar ({k})"),
                    None => "Checking grammar (whole essay)".into(),
                },
            )
        }
        "list_proposals" => (StepKind::Tool, "Reviewing proposals".into()),
        "set_paragraph_score" => (StepKind::ScoreParagraph, format!("Proposing score for {}", s("key"))),
        "add_comment" => (StepKind::Comment, format!("Proposing comment on {}", s("key"))),
        "propose_edit" => (StepKind::Comment, format!("Proposing edit in {}", s("key"))),
        "web_search" => (StepKind::WebSearch, format!("Searching the web: “{}”", s("query"))),
        "web_fetch" => (StepKind::WebFetch, format!("Reading {}", s("url"))),
        other => (StepKind::Tool, format!("Running {other}")),
    }
}

#[derive(Deserialize)]
struct KeyArgs {
    key: String,
}

pub async fn execute(ctx: &RunCtx, call: &ToolCall) -> ToolOutcome {
    let res = match call.name.as_str() {
        "get_rubric" => {
            let s = ctx.session.read().await;
            Ok(ToolOutcome::ok(format!("{} chars", s.rubric_md.len()), s.rubric_md.clone()))
        }
        "list_paragraphs" => {
            let s = ctx.session.read().await;
            Ok(ToolOutcome::ok(format!("{} paragraphs", s.paragraphs.len()), paragraph_index(&s)))
        }
        "get_paragraph" => get_paragraph(ctx, &call.arguments).await,
        "get_assessment" => {
            let s = ctx.session.read().await;
            Ok(match &s.original_assessment {
                Some(a) => ToolOutcome::ok(
                    format!("{:.1}/{:.1}", a.overall, a.max),
                    serde_json::to_string_pretty(a).unwrap_or_default(),
                ),
                None => ToolOutcome::err("the essay has not been assessed yet"),
            })
        }
        "check_grammar" => check_grammar(ctx, &call.arguments).await,
        "list_proposals" => {
            let s = ctx.session.read().await;
            let lines: Vec<String> = s
                .proposals
                .iter()
                .rev()
                .take(40)
                .map(|p| {
                    let what = match &p.annotation {
                        Annotation::Score { para, score, .. } => format!("score {para} → {:.0}", score * 100.0),
                        Annotation::Comment { para, text, .. } => format!("comment {para}: {}", truncate(text, 80)),
                        Annotation::Edit { para, anchor, replacement, .. } => {
                            format!("edit {para}: \"{}\" → \"{}\"", anchor.quote, replacement)
                        }
                    };
                    let note = p.note.as_deref().map(|n| format!(" (teacher: {n})")).unwrap_or_default();
                    format!("{} [{:?}] {what}{note}", p.id, p.status)
                })
                .collect();
            Ok(ToolOutcome::ok(
                format!("{} proposals", s.proposals.len()),
                if lines.is_empty() { "No proposals yet.".into() } else { lines.join("\n") },
            ))
        }
        "set_paragraph_score" => set_score(ctx, &call.arguments).await,
        "add_comment" => add_comment(ctx, &call.arguments).await,
        "propose_edit" => propose_edit(ctx, &call.arguments).await,
        "web_search" => web_search(ctx, &call.arguments).await,
        "web_fetch" => web_fetch(ctx, &call.arguments).await,
        other => Ok(ToolOutcome::err(format!("unknown tool '{other}'"))),
    };
    let mut out = res.unwrap_or_else(|e: anyhow::Error| ToolOutcome::err(e.to_string()));
    out.content = truncate(&out.content, MAX_RESULT_CHARS);
    out
}

fn args<T: for<'de> Deserialize<'de>>(v: &Value) -> anyhow::Result<T> {
    serde_json::from_value(v.clone()).map_err(|e| anyhow::anyhow!("invalid arguments: {e}"))
}

async fn get_paragraph(ctx: &RunCtx, a: &Value) -> anyhow::Result<ToolOutcome> {
    let KeyArgs { key } = args(a)?;
    let s = ctx.session.read().await;
    let p = s.paragraph(&key).ok_or_else(|| anyhow::anyhow!("no paragraph {key}"))?;
    let rationale = s.annotations.iter().find_map(|x| match x {
        Annotation::Score { para, rationale, .. } if *para == p.key => Some(rationale.clone()),
        _ => None,
    });
    let mut out = format!("[{}]\n{}\n", p.key, p.text);
    if let Some(sc) = s.score_of(&p.key) {
        out.push_str(&format!("\nScore: {:.0}/100", sc * 100.0));
    }
    if let Some(r) = rationale {
        out.push_str(&format!("\nRationale: {r}"));
    }
    let comments = comments_for(&s, &p.key);
    if !comments.is_empty() {
        out.push_str("\nComments:\n");
        for c in comments {
            out.push_str(&format!("- {c}\n"));
        }
    }
    Ok(ToolOutcome::ok(format!("{} words", p.text.split_whitespace().count()), out))
}

async fn check_grammar(ctx: &RunCtx, a: &Value) -> anyhow::Result<ToolOutcome> {
    #[derive(Deserialize, Default)]
    struct A {
        #[serde(default)]
        keys: Option<Vec<String>>,
    }
    let A { keys } = args(a).unwrap_or_default();
    let paragraphs = {
        let s = ctx.session.read().await;
        match keys.filter(|k| !k.is_empty()) {
            Some(keys) => {
                s.paragraphs.iter().filter(|p| keys.iter().any(|k| k.eq_ignore_ascii_case(&p.key))).cloned().collect()
            }
            None => s.paragraphs.clone(),
        }
    };
    let settings = ctx.state.settings();
    let issues = ctx
        .state
        .grammar
        .check(
            paragraphs,
            parse_dialect(&settings.grading.dialect),
            settings.grading.disabled_lint_kinds.clone(),
            settings.grading.max_lints_per_paragraph as usize,
        )
        .await?;
    let content = if issues.is_empty() {
        "No grammar issues found.".to_string()
    } else {
        issues
            .iter()
            .map(|i| {
                let fix = i.replacement.as_deref().map(|r| format!(" → suggest \"{r}\"")).unwrap_or_default();
                format!("[{}] \"{}\"{fix} ({}: {})", i.para, i.anchor.quote, i.kind, i.message)
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    Ok(ToolOutcome::ok(format!("{} issue(s)", issues.len()), content).with_data(serde_json::to_value(&issues)?))
}

async fn set_score(ctx: &RunCtx, a: &Value) -> anyhow::Result<ToolOutcome> {
    #[derive(Deserialize)]
    struct A {
        key: String,
        score: f64,
        #[serde(default)]
        rationale: String,
    }
    let A { key, score, rationale } = args(a)?;
    let (para, id) = {
        let mut s = ctx.session.write().await;
        let para = s.paragraph(&key).ok_or_else(|| anyhow::anyhow!("no paragraph {key}"))?.key.clone();
        (para, s.next_id("a"))
    };
    let score = (score.clamp(0.0, 100.0) / 100.0) as f32;
    let pid = ctx.annotate(Annotation::Score { id, para: para.clone(), score, rationale }).await;
    Ok(ToolOutcome::ok(
        format!("{para} → {:.0}", score * 100.0),
        format!("Proposal {pid} created (score {para} → {:.0}); awaiting teacher approval.", score * 100.0),
    ))
}

async fn add_comment(ctx: &RunCtx, a: &Value) -> anyhow::Result<ToolOutcome> {
    #[derive(Deserialize)]
    struct A {
        key: String,
        #[serde(default)]
        quote: Option<String>,
        text: String,
    }
    let A { key, quote, text } = args(a)?;
    let (para, anchor, id) = {
        let mut s = ctx.session.write().await;
        let p = s.paragraph(&key).ok_or_else(|| anyhow::anyhow!("no paragraph {key}"))?;
        let (para, anchor) = (p.key.clone(), resolve_quote(&p.text, quote.as_deref()));
        (para, anchor, s.next_id("a"))
    };
    let anchored = anchor.is_some();
    let pid =
        ctx.annotate(Annotation::Comment { id, para: para.clone(), anchor, text, author: CommentAuthor::Agent }).await;
    let note = if quote.is_some() && !anchored { " (quote not found; attached to whole paragraph)" } else { "" };
    Ok(ToolOutcome::ok(
        format!("comment on {para}{note}"),
        format!("Proposal {pid} created{note}; awaiting teacher approval."),
    ))
}

async fn propose_edit(ctx: &RunCtx, a: &Value) -> anyhow::Result<ToolOutcome> {
    #[derive(Deserialize)]
    struct A {
        key: String,
        original: String,
        replacement: String,
        #[serde(default)]
        reason: String,
    }
    let A { key, original, replacement, reason } = args(a)?;
    let (para, anchor, id): (String, Anchor, String) = {
        let mut s = ctx.session.write().await;
        let p = s.paragraph(&key).ok_or_else(|| anyhow::anyhow!("no paragraph {key}"))?;
        let anchor = find_anchor(&p.text, &original, None).ok_or_else(|| {
            anyhow::anyhow!("the text \"{}\" does not occur in {}; copy it exactly", truncate(&original, 80), p.key)
        })?;
        (p.key.clone(), anchor, s.next_id("a"))
    };
    let pid = ctx
        .annotate(Annotation::Edit {
            id,
            para: para.clone(),
            anchor: anchor.clone(),
            replacement: replacement.clone(),
            reason,
            source: EditSource::Agent,
            lint_kind: None,
        })
        .await;
    Ok(ToolOutcome::ok(
        format!("\"{}\" → \"{}\"", truncate(&anchor.quote, 40), truncate(&replacement, 40)),
        format!("Proposal {pid} created; awaiting teacher approval."),
    ))
}

async fn web_search(ctx: &RunCtx, a: &Value) -> anyhow::Result<ToolOutcome> {
    #[derive(Deserialize)]
    struct A {
        query: String,
        #[serde(default)]
        max_results: Option<u32>,
    }
    let A { query, max_results } = args(a)?;
    let web = ctx.web.as_ref().ok_or_else(|| anyhow::anyhow!("web search needs an Ollama API key"))?;
    let results = web.search(&query, max_results.unwrap_or(5)).await?;
    let content = results
        .iter()
        .enumerate()
        .map(|(i, r)| format!("{}. {}\n{}\n{}", i + 1, r.title, r.url, truncate(&r.content, 900)))
        .collect::<Vec<_>>()
        .join("\n\n");
    let data = json!(results.iter().map(|r| json!({"title": r.title, "url": r.url})).collect::<Vec<_>>());
    Ok(ToolOutcome::ok(
        format!("{} result(s)", results.len()),
        if content.is_empty() { "No results.".into() } else { content },
    )
    .with_data(data))
}

async fn web_fetch(ctx: &RunCtx, a: &Value) -> anyhow::Result<ToolOutcome> {
    #[derive(Deserialize)]
    struct A {
        url: String,
    }
    let A { url } = args(a)?;
    let web = ctx.web.as_ref().ok_or_else(|| anyhow::anyhow!("web fetch needs an Ollama API key"))?;
    let page = web.fetch(&url).await?;
    Ok(ToolOutcome::ok(
        format!("{} ({} chars)", truncate(&page.title, 60), page.content.len()),
        format!("{}\n\n{}", page.title, page.content),
    )
    .with_data(json!({"title": page.title, "url": url})))
}
