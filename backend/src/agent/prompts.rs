//! Prompt text and the context blocks shared between grading and chat.

use crate::events::Annotation;
use crate::llm::truncate;
use crate::session::Session;

pub const GRADER_ROLE: &str = "You are a careful, fair essay grader. You ground every judgement in the essay text and \
the rubric, quote the essay when you criticise it, and never invent facts about the essay.";

pub const RUBRIC_SYSTEM: &str = "Extract the grading criteria from a rubric written in Markdown. Use the rubric's own \
criterion names and point values. If the rubric gives no points, assign each criterion an equal share of 100. \
Keep descriptions short (one or two sentences summarising what earns full marks).";

pub const THESIS_SYSTEM: &str = "Identify the central thesis (main claim or purpose) of the essay. Quote or closely \
paraphrase the essay's own statement of it. If it is implicit, state it in one sentence and say so.";

pub const PARAGRAPH_SYSTEM: &str = "You score how much ONE paragraph of an essay contributes to the essay's thesis.\n\
Score 0-100 using these anchors:\n\
- 90-100: directly and convincingly advances the thesis (clear claim, strong evidence, analysis tied back to the thesis).\n\
- 70-89: supports the thesis, with minor weaknesses (thin evidence, loose connection, some vagueness).\n\
- 45-69: neutral or partly relevant: summary, filler, generic statements, or support that is asserted but not shown.\n\
- 20-44: weak: mostly off-topic, unsupported, confusing, or undercuts the argument.\n\
- 0-19: contradicts or derails the thesis.\n\
Introductions and conclusions are judged on how well they frame or close the argument. Use the full range; do not \
default to 70-80. Add at most 3 specific comments; each comment's `quote` must be copied EXACTLY from the paragraph \
(a short phrase or sentence), and the comment must say what to improve or what works.";

pub const CLAIMS_SYSTEM: &str = "List the essay's most important checkable factual claims: statistics, dates, \
historical events, scientific statements, attributions of quotes. Skip opinions, the thesis itself, and common \
knowledge. For each, copy the claim EXACTLY as written in the paragraph and give a concise web search query.";

pub const VERDICT_SYSTEM: &str = "Decide whether web search results support a factual claim from an essay. \
`supported` = the sources agree; `contradicted` = reliable sources say otherwise; `unverifiable` = the results do \
not settle it. Be conservative: only say contradicted when the evidence is clear. Cite the most relevant URL.";

pub const ASSESSMENT_SYSTEM: &str = "Write the final assessment of the essay against the rubric. Score every rubric \
criterion (never above its maximum) with a justification that cites paragraph keys like [P3] and short quotes as \
evidence. The overall score is the sum of criterion scores. Consider paragraph scores, grammar issues, and \
fact-check results provided. Be specific and constructive.";

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
by key, e.g. [P3]. Keep answers concise and use Markdown.\n",
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
