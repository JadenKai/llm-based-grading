//! Harper grammar checking. `LintGroup::lint` needs `&mut self`, so linters are pooled and
//! all work happens on the blocking thread pool.

use std::sync::{Arc, Mutex};

use harper_core::linting::{LintGroup, Linter, Suggestion};
use harper_core::spell::FstDictionary;
use harper_core::{Dialect, Document};
use serde::Serialize;

use crate::events::{Anchor, Paragraph};
use crate::text::anchor_from_chars;

#[derive(Debug, Clone, Serialize)]
pub struct GrammarIssue {
    pub para: String,
    pub anchor: Anchor,
    /// `None` when Harper only flags the problem without a fix.
    pub replacement: Option<String>,
    pub message: String,
    pub kind: String,
}

#[derive(Default)]
pub struct Grammar {
    pool: Mutex<Vec<(Dialect, LintGroup)>>,
}

pub fn parse_dialect(s: &str) -> Dialect {
    match s.to_ascii_lowercase().as_str() {
        "british" => Dialect::British,
        "canadian" => Dialect::Canadian,
        "australian" => Dialect::Australian,
        "indian" => Dialect::Indian,
        _ => Dialect::American,
    }
}

impl Grammar {
    fn take(&self, dialect: Dialect) -> LintGroup {
        let mut pool = self.pool.lock().unwrap();
        if let Some(i) = pool.iter().position(|(d, _)| *d == dialect) {
            return pool.swap_remove(i).1;
        }
        drop(pool);
        LintGroup::new_curated(FstDictionary::curated(), dialect)
    }

    fn give(&self, dialect: Dialect, group: LintGroup) {
        let mut pool = self.pool.lock().unwrap();
        if pool.len() < 4 {
            pool.push((dialect, group));
        }
    }

    pub fn check_blocking(
        &self,
        paragraphs: &[Paragraph],
        dialect: Dialect,
        disabled_kinds: &[String],
        max_per_paragraph: usize,
    ) -> Vec<GrammarIssue> {
        let mut linter = self.take(dialect);
        let mut out = Vec::new();
        for p in paragraphs {
            if p.text.trim().is_empty() {
                continue;
            }
            let doc = Document::new_plain_english_curated(&p.text);
            let mut lints = linter.lint(&doc);
            lints.sort_by_key(|l| (l.priority, l.span.start));
            // Several rules often flag the same span (e.g. Typo + Spelling); keep the most important.
            let mut seen = std::collections::HashSet::new();
            let mut issues: Vec<GrammarIssue> = lints
                .into_iter()
                .filter(|l| {
                    let kind = l.lint_kind.to_string_key();
                    let label = l.lint_kind.to_string();
                    !disabled_kinds.iter().any(|d| d.eq_ignore_ascii_case(&kind) || d.eq_ignore_ascii_case(&label))
                })
                .filter(|l| seen.insert((l.span.start, l.span.end)))
                .take(max_per_paragraph)
                .map(|l| {
                    let anchor = anchor_from_chars(&p.text, l.span.start, l.span.end);
                    let replacement = l.suggestions.first().map(|s| match s {
                        Suggestion::ReplaceWith(chars) => chars.iter().collect(),
                        Suggestion::Remove => String::new(),
                        Suggestion::InsertAfter(chars) => {
                            format!("{}{}", anchor.quote, chars.iter().collect::<String>())
                        }
                    });
                    GrammarIssue {
                        para: p.key.clone(),
                        anchor,
                        replacement,
                        message: l.message,
                        kind: l.lint_kind.to_string(),
                    }
                })
                .collect();
            issues.sort_by_key(|i| i.anchor.start);
            out.extend(issues);
        }
        self.give(dialect, linter);
        out
    }

    pub async fn check(
        self: &Arc<Self>,
        paragraphs: Vec<Paragraph>,
        dialect: Dialect,
        disabled_kinds: Vec<String>,
        max_per_paragraph: usize,
    ) -> anyhow::Result<Vec<GrammarIssue>> {
        let me = self.clone();
        Ok(tokio::task::spawn_blocking(move || {
            me.check_blocking(&paragraphs, dialect, &disabled_kinds, max_per_paragraph)
        })
        .await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_article_error_with_utf16_offsets() {
        let g = Grammar::default();
        let paras = vec![Paragraph { key: "P1".into(), index: 0, text: "😀 This is an test.".into() }];
        let issues = g.check_blocking(&paras, Dialect::American, &[], 10);
        let issue = issues.iter().find(|i| i.anchor.quote == "an").expect("lint for 'an'");
        // The emoji is 2 UTF-16 units, so "an" starts at 2 + 1 + 8 = 11.
        assert_eq!(issue.anchor.start, 11);
        assert_eq!(issue.replacement.as_deref(), Some("a"));
    }
}
