//! Wire types shared with the frontend. `cargo test` exports them to
//! `frontend/src/api/gen` via ts-rs (see `.cargo/config.toml`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq, Eq, Hash)]
#[ts(export)]
pub struct ModelRef {
    pub provider_id: String,
    pub model: String,
}

/// One essay paragraph as extracted by the editor. `key` is the stable handle ("P1", "P2", …)
/// used by the agent and the UI; offsets everywhere are UTF-16 code units within `text`.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Paragraph {
    pub key: String,
    pub index: u32,
    pub text: String,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[ts(export)]
pub struct Anchor {
    pub start: u32,
    pub length: u32,
    pub quote: String,
}

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CommentAuthor {
    Agent,
    Grammar,
    FactCheck,
}

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum EditSource {
    Harper,
    Agent,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum Annotation {
    Score {
        id: String,
        para: String,
        /// 0.0 (detracts from the thesis) ..= 1.0 (directly advances it).
        score: f32,
        rationale: String,
    },
    Comment {
        id: String,
        para: String,
        anchor: Option<Anchor>,
        text: String,
        author: CommentAuthor,
    },
    Edit {
        id: String,
        para: String,
        anchor: Anchor,
        replacement: String,
        reason: String,
        source: EditSource,
        lint_kind: Option<String>,
    },
}

impl Annotation {
    pub fn id(&self) -> &str {
        match self {
            Annotation::Score { id, .. } | Annotation::Comment { id, .. } | Annotation::Edit { id, .. } => id,
        }
    }

    pub fn para(&self) -> &str {
        match self {
            Annotation::Score { para, .. } | Annotation::Comment { para, .. } | Annotation::Edit { para, .. } => para,
        }
    }
}

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProposalStatus {
    Pending,
    Accepted,
    Rejected,
    Stale,
}

/// A change awaiting user approval. Grammar edits from grading and every annotation the chat
/// agent makes are proposals; nothing is applied until the user accepts it.
#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Proposal {
    pub id: String,
    pub annotation: Annotation,
    pub status: ProposalStatus,
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct CriterionScore {
    pub name: String,
    pub score: f32,
    pub max: f32,
    pub justification: String,
    pub evidence: Vec<String>,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct Assessment {
    pub thesis: String,
    pub overall: f32,
    pub max: f32,
    pub summary: String,
    pub strengths: Vec<String>,
    pub improvements: Vec<String>,
    pub criteria: Vec<CriterionScore>,
    pub model: ModelRef,
    pub created_at: String,
}

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RunKind {
    Grade,
    Chat,
}

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum StepKind {
    ReadRubric,
    Grammar,
    Thesis,
    ScoreParagraph,
    FactCheck,
    WebSearch,
    WebFetch,
    Comment,
    Assessment,
    Llm,
    Tool,
}

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum StepStatus {
    Ok,
    Error,
    Skipped,
}

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RunStatus {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum Event {
    RunStarted {
        kind: RunKind,
        model: ModelRef,
    },
    UserMessage {
        text: String,
    },
    StepStarted {
        step_id: String,
        parent_id: Option<String>,
        kind: StepKind,
        label: String,
    },
    StepUpdated {
        step_id: String,
        label: Option<String>,
        detail: Option<String>,
    },
    StepFinished {
        step_id: String,
        status: StepStatus,
        summary: Option<String>,
    },
    ThinkingDelta {
        block_id: String,
        text: String,
    },
    TextDelta {
        message_id: String,
        text: String,
    },
    ToolCall {
        call_id: String,
        step_id: String,
        name: String,
        arguments: Value,
    },
    ToolResult {
        call_id: String,
        ok: bool,
        summary: String,
        data: Option<Value>,
    },
    /// Harper suggestions produced while grading; each is a pending proposal.
    GrammarLints {
        proposals: Vec<Proposal>,
    },
    /// Applied directly (grading pipeline only).
    AnnotationApplied {
        annotation: Annotation,
    },
    /// Needs user approval (chat agent).
    ProposalCreated {
        proposal: Proposal,
    },
    Assessment {
        assessment: Assessment,
        original: bool,
    },
    Usage {
        prompt_tokens: Option<u32>,
        completion_tokens: Option<u32>,
    },
    Error {
        message: String,
        recoverable: bool,
    },
    RunFinished {
        status: RunStatus,
    },
}

/// What actually goes over SSE: an event plus ordering metadata.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Envelope {
    pub seq: u64,
    pub run_id: String,
    #[serde(flatten)]
    pub event: Event,
}
