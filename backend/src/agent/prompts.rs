//! Prompt text and the context blocks shared between grading and chat.

use crate::events::Annotation;
use crate::llm::truncate;
use crate::session::Session;

pub const GRADER_ROLE: &str = "You are a careful, fair essay grader. Ground every judgement in the essay text and \
the rubric, quote the essay when you criticise it, and never invent facts about the essay.";

/// Appended to every grading prompt: teachers read many of these, so every word must earn its place.
pub const BREVITY: &str = "Be as concise as possible: plain, specific words; no preamble, hedging or repetition.";

pub const RUBRIC_SYSTEM: &str = "Extract the grading criteria from a rubric written in Markdown. Use the rubric's own \
criterion names and point values. If the rubric gives no points, assign each criterion an equal share of 100. \
Each description is one short sentence on what earns full marks.";

pub const THESIS_SYSTEM: &str = "Identify the essay's central thesis (main claim). Quote or closely paraphrase the \
essay's own statement of it in one sentence.";

pub const PARAGRAPH_SYSTEM: &str = "Score how much ONE paragraph of an essay contributes to the essay's thesis, 0-100:\n\
- 90-100: directly and convincingly advances the thesis.\n\
- 70-89: supports it, with minor weaknesses (thin evidence, loose link, vagueness).\n\
- 45-69: neutral or partly relevant: summary, filler, support asserted but not shown.\n\
- 20-44: weak: mostly off-topic, unsupported or confusing.\n\
- 0-19: contradicts or derails the thesis.\n\
Judge introductions and conclusions on how well they frame or close the argument. Use the full range; do not default \
to 70-80. The rationale is one sentence of at most 20 words. Add at most 2 comments, only where they matter; each \
`quote` is a short phrase copied EXACTLY from the paragraph and each `comment` is at most 15 words.";

pub const CLAIMS_SYSTEM: &str = "List the essay's most important checkable factual claims (statistics, dates, events, \
scientific statements, attributed quotes). Skip opinions, the thesis and common knowledge. Copy each claim EXACTLY \
as written and give a short web search query.";

pub const VERDICT_SYSTEM: &str = "Decide whether web search results support a factual claim from an essay: \
`supported` (sources agree), `contradicted` (reliable sources say otherwise) or `unverifiable`. Only say \
contradicted when the evidence is clear. The explanation is one sentence. Cite the most relevant URL.";

pub const ASSESSMENT_SYSTEM: &str = "Assess the essay against the rubric. Score every criterion (never above its \
maximum); the overall score is their sum. Use the paragraph scores, grammar issues and fact-checks provided. Each \
justification is one sentence citing paragraph keys like [P3]; evidence items are short quotes. The summary is at \
most 2 sentences. Give at most 3 strengths and 3 improvements, each under 12 words.";

pub fn chat_system(s: &Session, extra: Option<&str>, web_enabled: bool) -> String {
    let mut out = String::new();
    out.push_str(GRADER_ROLE);
    out.push_str(
        "\n\nYou are now chatting with the teacher who is reviewing your grading of a student essay. Answer \
questions about the essay, the rubric and your assessment. Use tools to read paragraphs, check grammar",
    );
    if web_enabled {
        out.push_str(", and search the web to fact-check claims");
    }
    out.push_str(
        ".\n\nIMPORTANT: annotation tools (set_paragraph_score, add_comment, propose_edit) do NOT change anything \
directly. Each creates a proposal that the teacher must approve or reject. Only propose changes when they are \
warranted or requested, then tell the teacher briefly what you proposed. Messages may begin with [Review updates] \
listing the teacher's decisions on earlier proposals; respect them and do not re-propose rejected changes unless asked.\n\
Paragraph scores are 0-100 (the highlight goes from red at 0 through yellow to green at 100). Refer to paragraphs \
by key, e.g. [P3].\n\
Answer as briefly as possible: one to three sentences or a few short bullets, no preamble, no restating the \
question, no closing offers of further help. Use Markdown only when it helps.\n",
    );
    if let Some(extra) = extra {
        out.push_str("\nAdditional instructions from the teacher:\n");
        out.push_str(extra);
        out.push('\n');
    }
    out.push_str("\n## Rubric\n");
    out.push_str(&truncate(&s.rubric_md, 6000));
    out.push_str("\n\n## Essay context\n");
    if let Some(t) = &s.thesis {
        out.push_str(&format!("Thesis: {t}\n"));
    }
    out.push_str("Paragraph index (key, current score, opening words):\n");
    out.push_str(&paragraph_index(s));
    if let Some(a) = &s.original_assessment {
        out.push_str(&format!("\nOriginal assessment: {:.1}/{:.1}. {}\n", a.overall, a.max, truncate(&a.summary, 800)));
        for c in &a.criteria {
            out.push_str(&format!("- {}: {:.1}/{:.1}\n", c.name, c.score, c.max));
        }
    }
    if !s.fact_checks.is_empty() {
        out.push_str("\nFact checks performed:\n");
        for f in &s.fact_checks {
            out.push_str(&format!("- [{}] \"{}\" → {}\n", f.para, truncate(&f.claim, 120), f.verdict));
        }
    }
    let pending = s.proposals.iter().filter(|p| p.status == crate::events::ProposalStatus::Pending).count();
    if pending > 0 {
        out.push_str(&format!("\n{pending} proposal(s) are awaiting the teacher's review.\n"));
    }
    out
}

pub fn paragraph_index(s: &Session) -> String {
    s.paragraphs
        .iter()
        .filter(|p| !p.text.trim().is_empty())
        .map(|p| {
            let score = s
                .score_of(&p.key)
                .map(|v| format!("{:>3}", (v * 100.0).round() as i32))
                .unwrap_or_else(|| "  -".into());
            let words: String = p.text.split_whitespace().take(14).collect::<Vec<_>>().join(" ");
            format!("[{}] score {score} | {words}…\n", p.key)
        })
        .collect()
}

pub fn essay_block(s: &Session) -> String {
    s.paragraphs
        .iter()
        .filter(|p| !p.text.trim().is_empty())
        .map(|p| format!("[{}] {}", p.key, p.text.trim()))
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn comments_for(s: &Session, key: &str) -> Vec<String> {
    s.annotations
        .iter()
        .filter_map(|a| match a {
            Annotation::Comment { para, text, .. } if para == key => Some(text.clone()),
            _ => None,
        })
        .collect()
}
