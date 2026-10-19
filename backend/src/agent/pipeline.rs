//! Upload-time grading. A fixed sequence of schema-constrained calls rather than a free
//! agent loop, because many open models are unreliable at multi-step tool calling.

use futures::StreamExt;
use serde::Deserialize;
use serde_json::json;

use super::{RunCtx, is_cancelled, prompts};
use crate::events::{
    Annotation, Assessment, CommentAuthor, CriterionScore, EditSource, Event, Paragraph, Proposal, ProposalStatus,
    StepKind, StepStatus,
};
use crate::grammar::parse_dialect;
use crate::llm::truncate;
use crate::session::{FactCheck, RubricCriterion};
use crate::text::resolve_quote;

/// Titles, headings and bylines are not scored: very short lines, or short lines that do not
/// end like a sentence.
fn is_scorable(text: &str) -> bool {
    let words = text.split_whitespace().count();
    let ends_sentence = text.trim_end().ends_with(['.', '!', '?', '"', '\'', '”', '’', ')']);
    words >= 6 && (ends_sentence || words > 15)
}

pub async fn run_grading(ctx: &RunCtx) -> anyhow::Result<()> {
    let criteria = read_rubric(ctx).await?;
    grammar(ctx).await?;
    let thesis = thesis(ctx).await?;
    score_paragraphs(ctx, &thesis).await?;
    fact_check(ctx).await?;
    let assessment = assess(ctx, &thesis, &criteria).await?;

    let (pending, comments) = {
        let s = ctx.session.read().await;
        (
            s.proposals.iter().filter(|p| p.status == ProposalStatus::Pending).count(),
            s.annotations.iter().filter(|a| matches!(a, Annotation::Comment { .. })).count(),
        )
    };
    let msg = format!(
        "**Grading complete — {:.1} / {:.1}**\n\n{}\n\nParagraphs are highlighted from green (advances the thesis) \
to red (detracts). I left {comments} comment(s), and {pending} grammar suggestion(s) are waiting for your review in \
the Essay tab. The full breakdown is in **Original Assessment**. Ask me anything about the grade.",
        assessment.overall, assessment.max, assessment.summary
    );
    ctx.emit(Event::TextDelta { message_id: format!("{}_summary", ctx.run.id), text: msg });
    Ok(())
}

async fn read_rubric(ctx: &RunCtx) -> anyhow::Result<Vec<RubricCriterion>> {
    #[derive(Deserialize)]
    struct Out {
        criteria: Vec<RubricCriterion>,
    }
    let step = ctx.step_start(StepKind::ReadRubric, "Reading rubric", None);
    let rubric = ctx.session.read().await.rubric_md.clone();
    let schema = json!({
        "type": "object",
        "properties": {"criteria": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "max_points": {"type": "number"}, "description": {"type": "string"}
        }, "required": ["name", "max_points", "description"]}}},
        "required": ["criteria"]
    });
    let criteria = match ctx.complete_json::<Out>(prompts::RUBRIC_SYSTEM, &rubric, schema, &step).await {
        Ok(o) if !o.criteria.is_empty() => {
            ctx.step_end(&step, StepStatus::Ok, format!("{} criteria", o.criteria.len()));
            o.criteria
        }
        Err(e) if is_cancelled(&e) => return Err(e),
        other => {
            let why = other.err().map(|e| e.to_string()).unwrap_or_else(|| "no criteria found".into());
            ctx.step_end(&step, StepStatus::Error, format!("Could not parse rubric ({why}); using a single criterion"));
            vec![RubricCriterion {
                name: "Overall quality".into(),
                max_points: 100.0,
                description: "Holistic score against the rubric.".into(),
            }]
        }
    };
    ctx.session.write().await.criteria = criteria.clone();
    Ok(criteria)
}

async fn grammar(ctx: &RunCtx) -> anyhow::Result<()> {
    ctx.check_cancel()?;
    let step = ctx.step_start(StepKind::Grammar, "Checking grammar with Harper", None);
    let settings = ctx.state.settings();
    let paragraphs = ctx.session.read().await.paragraphs.clone();
    let issues = match ctx
        .state
        .grammar
        .check(
            paragraphs,
            parse_dialect(&settings.grading.dialect),
            settings.grading.disabled_lint_kinds.clone(),
            settings.grading.max_lints_per_paragraph as usize,
        )
        .await
    {
        Ok(i) => i,
        Err(e) => {
            ctx.step_end(&step, StepStatus::Error, e.to_string());
            return Ok(());
        }
    };

    let mut proposals = Vec::new();
    let mut notes = 0;
    {
        let mut s = ctx.session.write().await;
        for issue in issues {
            let id = s.next_id("a");
            match issue.replacement {
                Some(replacement) => {
                    let pid = s.next_id("p");
                    let p = Proposal {
                        id: pid,
                        status: ProposalStatus::Pending,
                        note: None,
                        annotation: Annotation::Edit {
                            id,
                            para: issue.para,
                            anchor: issue.anchor,
                            replacement,
                            reason: issue.message,
                            source: EditSource::Harper,
                            lint_kind: Some(issue.kind),
                        },
                    };
                    s.proposals.push(p.clone());
                    proposals.push(p);
                }
                // Flag-only lints (no fix available) become comments.
                None => {
                    notes += 1;
                    let ann = Annotation::Comment {
                        id,
                        para: issue.para,
                        anchor: Some(issue.anchor),
                        text: format!("{}: {}", issue.kind, issue.message),
                        author: CommentAuthor::Grammar,
                    };
                    s.apply_annotation(ann.clone());
                    ctx.emit(Event::AnnotationApplied { annotation: ann });
                }
            }
        }
    }
    let n = proposals.len();
    ctx.emit(Event::GrammarLints { proposals });
    ctx.step_end(&step, StepStatus::Ok, format!("{n} suggested fix(es), {notes} note(s)"));
    Ok(())
}

async fn thesis(ctx: &RunCtx) -> anyhow::Result<String> {
    #[derive(Deserialize)]
    struct Out {
        thesis: String,
        #[serde(default)]
        thesis_paragraph: Option<String>,
    }
    let step = ctx.step_start(StepKind::Thesis, "Identifying the thesis", None);
    let essay = prompts::essay_block(&*ctx.session.read().await);
    let schema = json!({"type": "object", "properties": {
        "thesis": {"type": "string"}, "thesis_paragraph": {"type": "string", "description": "Paragraph key, e.g. P1"}
    }, "required": ["thesis", "thesis_paragraph"]});
    match ctx.complete_json::<Out>(prompts::THESIS_SYSTEM, &format!("Essay:\n\n{essay}"), schema, &step).await {
        Ok(o) => {
            let where_ = o.thesis_paragraph.map(|p| format!(" [{p}]")).unwrap_or_default();
            ctx.step_end(&step, StepStatus::Ok, format!("{}{where_}", truncate(&o.thesis, 160)));
            ctx.session.write().await.thesis = Some(o.thesis.clone());
            Ok(o.thesis)
        }
        Err(e) if is_cancelled(&e) => Err(e),
        Err(e) => {
            ctx.step_end(&step, StepStatus::Error, format!("{e}; continuing without an explicit thesis"));
            Ok("(not identified)".into())
        }
    }
}

async fn score_paragraphs(ctx: &RunCtx, thesis: &str) -> anyhow::Result<()> {
    let (paragraphs, essay, rubric) = {
        let s = ctx.session.read().await;
        let ps: Vec<Paragraph> = s.paragraphs.iter().filter(|p| is_scorable(&p.text)).cloned().collect();
        (ps, prompts::essay_block(&s), truncate(&s.rubric_md, 4000))
    };
    let parent = ctx.step_start(StepKind::ScoreParagraph, format!("Scoring {} paragraphs", paragraphs.len()), None);
    let settings = ctx.state.settings();
    let concurrency =
        if ctx.provider.is_remote() { settings.grading.concurrency_remote } else { settings.grading.concurrency_local }
            .max(1) as usize;

    let total = paragraphs.len();
    let results: Vec<anyhow::Result<bool>> = futures::stream::iter(paragraphs)
        .map(|p| {
            let ctx = ctx.clone();
            let (essay, rubric, parent) = (essay.clone(), rubric.clone(), parent.clone());
            let thesis = thesis.to_string();
            async move { score_one(&ctx, &p, &thesis, &essay, &rubric, &parent).await }
        })
        .buffer_unordered(concurrency)
        .collect()
        .await;
    ctx.check_cancel()?;
    let ok = results.iter().filter(|r| matches!(r, Ok(true))).count();
    ctx.step_end(&parent, if ok == total { StepStatus::Ok } else { StepStatus::Error }, format!("{ok}/{total} scored"));
    Ok(())
}

async fn score_one(
    ctx: &RunCtx,
    p: &Paragraph,
    thesis: &str,
    essay: &str,
    rubric: &str,
    parent: &str,
) -> anyhow::Result<bool> {
    #[derive(Deserialize)]
    struct C {
        quote: String,
        comment: String,
    }
    #[derive(Deserialize)]
    struct Out {
        score: f64,
        #[serde(default)]
        role: String,
        rationale: String,
        #[serde(default)]
        comments: Vec<C>,
    }
    let step = ctx.step_start(StepKind::ScoreParagraph, format!("Scoring paragraph {}", p.key), Some(parent));
    let schema = json!({"type": "object", "properties": {
        "role": {"type": "string", "description": "introduction, thesis, evidence, analysis, counterargument, transition, conclusion, or off-topic"},
        "score": {"type": "integer", "minimum": 0, "maximum": 100},
        "rationale": {"type": "string"},
        "comments": {"type": "array", "maxItems": 3, "items": {"type": "object", "properties": {
            "quote": {"type": "string"}, "comment": {"type": "string"}
        }, "required": ["quote", "comment"]}}
    }, "required": ["role", "score", "rationale", "comments"]});
    let user = format!(
        "Thesis: {thesis}\n\nRubric (for context):\n{rubric}\n\nFull essay:\n{essay}\n\n---\nScore paragraph [{}]:\n{}",
        p.key, p.text
    );
    let out = match ctx.complete_json::<Out>(prompts::PARAGRAPH_SYSTEM, &user, schema, &step).await {
        Ok(o) => o,
        Err(e) if is_cancelled(&e) => return Err(e),
        Err(e) => {
            ctx.step_end(&step, StepStatus::Error, e.to_string());
            return Ok(false);
        }
    };
    let score = (out.score.clamp(0.0, 100.0) / 100.0) as f32;
    let mut anns = Vec::new();
    {
        let mut s = ctx.session.write().await;
        let rationale =
            if out.role.is_empty() { out.rationale.clone() } else { format!("({}) {}", out.role, out.rationale) };
        anns.push(Annotation::Score { id: s.next_id("a"), para: p.key.clone(), score, rationale });
        for c in out.comments.into_iter().take(3) {
            anns.push(Annotation::Comment {
                id: s.next_id("a"),
                para: p.key.clone(),
                anchor: resolve_quote(&p.text, Some(&c.quote)),
                text: c.comment,
                author: CommentAuthor::Agent,
            });
        }
    }
    let n_comments = anns.len() - 1;
    for a in anns {
        ctx.annotate(a).await;
    }
    ctx.step_end(&step, StepStatus::Ok, format!("{:.0}/100 · {n_comments} comment(s)", score * 100.0));
    Ok(true)
}

async fn fact_check(ctx: &RunCtx) -> anyhow::Result<()> {
    #[derive(Deserialize)]
    struct Claim {
        para: String,
        claim: String,
        search_query: String,
    }
    #[derive(Deserialize)]
    struct Claims {
        claims: Vec<Claim>,
    }
    #[derive(Deserialize)]
    struct Verdict {
        verdict: String,
        explanation: String,
        #[serde(default)]
        source_url: Option<String>,
    }

    let settings = ctx.state.settings();
    let Some(web) = ctx.web.clone().filter(|_| settings.grading.fact_check && settings.grading.max_fact_checks > 0)
    else {
        let step = ctx.step_start(StepKind::FactCheck, "Fact-checking", None);
        let why = if settings.grading.fact_check {
            "add an Ollama API key to enable web search"
        } else {
            "disabled in settings"
        };
        ctx.step_end(&step, StepStatus::Skipped, format!("Skipped — {why}"));
        return Ok(());
    };

    let parent = ctx.step_start(StepKind::FactCheck, "Fact-checking claims", None);
    let essay = prompts::essay_block(&*ctx.session.read().await);
    let max = settings.grading.max_fact_checks;
    let schema = json!({"type": "object", "properties": {"claims": {"type": "array", "maxItems": max, "items": {
        "type": "object", "properties": {
            "para": {"type": "string"}, "claim": {"type": "string"}, "search_query": {"type": "string"}
        }, "required": ["para", "claim", "search_query"]}}}, "required": ["claims"]});
    let claims = match ctx
        .complete_json::<Claims>(
            prompts::CLAIMS_SYSTEM,
            &format!("List at most {max} claims.\n\nEssay:\n{essay}"),
            schema,
            &parent,
        )
        .await
    {
        Ok(c) => c.claims,
        Err(e) if is_cancelled(&e) => return Err(e),
        Err(e) => {
            ctx.step_end(&parent, StepStatus::Error, e.to_string());
            return Ok(());
        }
    };
    if claims.is_empty() {
        ctx.step_end(&parent, StepStatus::Ok, "No checkable factual claims found");
        return Ok(());
    }

    let mut flagged = 0;
    let n = claims.len().min(max as usize);
    for claim in claims.into_iter().take(max as usize) {
        ctx.check_cancel()?;
        let step = ctx.step_start(
            StepKind::WebSearch,
            format!("Searching the web: “{}”", truncate(&claim.search_query, 80)),
            Some(&parent),
        );
        let call_id = format!("fc_{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        ctx.emit(Event::ToolCall {
            call_id: call_id.clone(),
            step_id: step.clone(),
            name: "web_search".into(),
            arguments: json!({"query": claim.search_query}),
        });
        let results = match web.search(&claim.search_query, 5).await {
            Ok(r) => r,
            Err(e) => {
                ctx.emit(Event::ToolResult { call_id, ok: false, summary: e.to_string(), data: None });
                ctx.step_end(&step, StepStatus::Error, e.to_string());
                continue;
            }
        };
        ctx.emit(Event::ToolResult {
            call_id,
            ok: true,
            summary: format!("{} result(s)", results.len()),
            data: Some(json!(results.iter().map(|r| json!({"title": r.title, "url": r.url})).collect::<Vec<_>>())),
        });
        let sources = results
            .iter()
            .map(|r| format!("- {} ({})\n  {}", r.title, r.url, truncate(&r.content, 700)))
            .collect::<Vec<_>>()
            .join("\n");
        let vschema = json!({"type": "object", "properties": {
            "verdict": {"type": "string", "enum": ["supported", "contradicted", "unverifiable"]},
            "explanation": {"type": "string"},
            "source_url": {"type": "string"}
        }, "required": ["verdict", "explanation", "source_url"]});
        let verdict = match ctx
            .complete_json::<Verdict>(
                prompts::VERDICT_SYSTEM,
                &format!("Claim: {}\n\nSearch results:\n{sources}", claim.claim),
                vschema,
                &step,
            )
            .await
        {
            Ok(v) => v,
            Err(e) if is_cancelled(&e) => return Err(e),
            Err(e) => {
                ctx.step_end(&step, StepStatus::Error, e.to_string());
                continue;
            }
        };
        let v = verdict.verdict.to_lowercase();
        let source = verdict.source_url.filter(|u| u.starts_with("http"));
        let (para_key, anchor) = {
            let s = ctx.session.read().await;
            match s.paragraph(&claim.para) {
                Some(p) => (p.key.clone(), resolve_quote(&p.text, Some(&claim.claim))),
                None => (claim.para.clone(), None),
            }
        };
        if v != "supported" {
            flagged += 1;
            let id = ctx.session.write().await.next_id("a");
            let src = source.as_deref().map(|u| format!(" Source: {u}")).unwrap_or_default();
            let label =
                if v == "contradicted" { "Fact-check: likely inaccurate." } else { "Fact-check: could not verify." };
            ctx.annotate(Annotation::Comment {
                id,
                para: para_key.clone(),
                anchor,
                text: format!("{label} {}{src}", verdict.explanation),
                author: CommentAuthor::FactCheck,
            })
            .await;
        }
        ctx.session.write().await.fact_checks.push(FactCheck {
            para: para_key,
            claim: claim.claim,
            verdict: v.clone(),
            explanation: verdict.explanation,
            source_url: source,
        });
        ctx.step_end(&step, StepStatus::Ok, v);
    }
    ctx.step_end(&parent, StepStatus::Ok, format!("{n} claim(s) checked, {flagged} flagged"));
    Ok(())
}

async fn assess(ctx: &RunCtx, thesis: &str, criteria: &[RubricCriterion]) -> anyhow::Result<Assessment> {
    #[derive(Deserialize)]
    struct Crit {
        name: String,
        score: f32,
        #[serde(default)]
        max: Option<f32>,
        justification: String,
        #[serde(default)]
        evidence: Vec<String>,
    }
    #[derive(Deserialize)]
    struct Out {
        summary: String,
        #[serde(default)]
        strengths: Vec<String>,
        #[serde(default)]
        improvements: Vec<String>,
        criteria: Vec<Crit>,
    }
    let step = ctx.step_start(StepKind::Assessment, "Writing rubric assessment", None);
    let context = {
        let s = ctx.session.read().await;
        let mut c = format!("Thesis: {thesis}\n\nRubric:\n{}\n\nCriteria to score:\n", truncate(&s.rubric_md, 6000));
        for k in criteria {
            c.push_str(&format!("- {} (max {}): {}\n", k.name, k.max_points, k.description));
        }
        c.push_str("\nParagraph scores (0-100, contribution to thesis) with rationale:\n");
        for a in &s.annotations {
            if let Annotation::Score { para, score, rationale, .. } = a {
                c.push_str(&format!("[{para}] {:.0}: {}\n", score * 100.0, truncate(rationale, 300)));
            }
        }
        let grammar = s.proposals.iter().filter(|p| matches!(p.annotation, Annotation::Edit { .. })).count();
        c.push_str(&format!("\nGrammar checker issues: {grammar}\n"));
        if !s.fact_checks.is_empty() {
            c.push_str("\nFact checks:\n");
            for f in &s.fact_checks {
                c.push_str(&format!("[{}] \"{}\" → {}: {}\n", f.para, f.claim, f.verdict, f.explanation));
            }
        }
        c.push_str(&format!("\nEssay:\n{}", prompts::essay_block(&s)));
        c
    };
    let schema = json!({"type": "object", "properties": {
        "summary": {"type": "string"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "improvements": {"type": "array", "items": {"type": "string"}},
        "criteria": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "score": {"type": "number"}, "max": {"type": "number"},
            "justification": {"type": "string"}, "evidence": {"type": "array", "items": {"type": "string"}}
        }, "required": ["name", "score", "max", "justification", "evidence"]}}
    }, "required": ["summary", "strengths", "improvements", "criteria"]});

    let out = match ctx.complete_json::<Out>(prompts::ASSESSMENT_SYSTEM, &context, schema, &step).await {
        Ok(o) => o,
        Err(e) => {
            ctx.step_end(&step, StepStatus::Error, e.to_string());
            return Err(e);
        }
    };

    // Trust the rubric's maxima over the model's, and clamp.
    let crits: Vec<CriterionScore> = out
        .criteria
        .into_iter()
        .map(|c| {
            let max = criteria
                .iter()
                .find(|k| k.name.eq_ignore_ascii_case(&c.name))
                .map(|k| k.max_points)
                .or(c.max)
                .unwrap_or(10.0)
                .max(0.0);
            CriterionScore {
                score: c.score.clamp(0.0, max),
                max,
                name: c.name,
                justification: c.justification,
                evidence: c.evidence,
            }
        })
        .collect();
    let overall = crits.iter().map(|c| c.score).sum::<f32>();
    let max = crits.iter().map(|c| c.max).sum::<f32>();
    let assessment = Assessment {
        thesis: thesis.to_string(),
        overall: (overall * 10.0).round() / 10.0,
        max,
        summary: out.summary,
        strengths: out.strengths,
        improvements: out.improvements,
        criteria: crits,
        model: ctx.model.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    {
        let mut s = ctx.session.write().await;
        // The original assessment is a frozen snapshot: written once, never replaced.
        if s.original_assessment.is_none() {
            s.original_assessment = Some(assessment.clone());
        }
        s.graded = true;
    }
    ctx.emit(Event::Assessment { assessment: assessment.clone(), original: true });
    ctx.step_end(&step, StepStatus::Ok, format!("{:.1} / {:.1}", assessment.overall, assessment.max));
    Ok(assessment)
}

#[cfg(test)]
mod tests {
    use super::is_scorable;

    #[test]
    fn skips_titles_and_headings() {
        assert!(!is_scorable("The Case for Four-Day School Weeks"));
        assert!(!is_scorable("Introduction"));
        assert!(!is_scorable("By Jane Doe, Period 3."));
        assert!(is_scorable("A shorter week reduces burnout for most students."));
        assert!(is_scorable(
            "this long run-on paragraph has no final punctuation but clearly is body text written by a student"
        ));
    }
}
