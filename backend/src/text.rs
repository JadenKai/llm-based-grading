//! Offset conversion and fuzzy quote anchoring. The editor addresses text in UTF-16 code
//! units; Harper reports `char` (Unicode scalar) spans; LLMs quote text loosely.

use crate::events::Anchor;

/// `prefix[i]` = UTF-16 offset of char index `i` (length `chars + 1`).
pub fn utf16_prefix(text: &str) -> Vec<u32> {
    let mut out = Vec::with_capacity(text.len() + 1);
    let mut acc = 0u32;
    out.push(0);
    for c in text.chars() {
        acc += c.len_utf16() as u32;
        out.push(acc);
    }
    out
}

/// Char span -> UTF-16 anchor.
pub fn anchor_from_chars(text: &str, start: usize, end: usize) -> Anchor {
    let prefix = utf16_prefix(text);
    let n = prefix.len() - 1;
    let (s, e) = (start.min(n), end.min(n).max(start.min(n)));
    Anchor { start: prefix[s], length: prefix[e] - prefix[s], quote: text.chars().skip(s).take(e - s).collect() }
}

/// Slice `text` by a UTF-16 range, if it falls on char boundaries.
pub fn slice_utf16(text: &str, start: u32, length: u32) -> Option<String> {
    let prefix = utf16_prefix(text);
    let s = prefix.iter().position(|&p| p == start)?;
    let e = prefix.iter().position(|&p| p == start + length)?;
    Some(text.chars().skip(s).take(e - s).collect())
}

fn normalize_char(c: char) -> char {
    match c {
        '\u{2018}' | '\u{2019}' | '\u{201B}' | '\u{2032}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{201F}' | '\u{2033}' => '"',
        '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
        '\u{00A0}' | '\u{2009}' | '\u{202F}' => ' ',
        c => c,
    }
}

/// Normalized form with a map back to original char indices: quotes/dashes unified,
/// whitespace runs collapsed, lowercased.
fn normalized(text: &str) -> (Vec<char>, Vec<usize>) {
    let mut out = Vec::new();
    let mut map = Vec::new();
    let mut prev_space = false;
    for (i, c) in text.chars().enumerate() {
        let c = normalize_char(c);
        if c.is_whitespace() {
            if prev_space {
                continue;
            }
            prev_space = true;
            out.push(' ');
        } else {
            prev_space = false;
            out.extend(c.to_lowercase());
            // to_lowercase may expand; map every produced char to the source index.
            while map.len() < out.len() - 1 {
                map.push(i);
            }
        }
        map.push(i);
    }
    (out, map)
}

fn find_sub(hay: &[char], needle: &[char]) -> Vec<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return vec![];
    }
    (0..=hay.len() - needle.len()).filter(|&i| hay[i..i + needle.len()] == *needle).collect()
}

/// Locate `quote` in `text`, preferring the occurrence closest to `near` (UTF-16 offset).
/// Falls back from exact to normalized matching. Returns `None` when absent.
pub fn find_anchor(text: &str, quote: &str, near: Option<u32>) -> Option<Anchor> {
    let quote = quote.trim();
    if quote.is_empty() {
        return None;
    }
    let chars: Vec<char> = text.chars().collect();
    let qchars: Vec<char> = quote.chars().collect();
    let prefix = utf16_prefix(text);
    let pick = |cands: Vec<(usize, usize)>| -> Option<Anchor> {
        let best = match near {
            Some(n) => cands.into_iter().min_by_key(|(s, _)| (prefix[*s] as i64 - n as i64).abs()),
            None => cands.into_iter().next(),
        }?;
        Some(anchor_from_chars(text, best.0, best.1))
    };

    let exact: Vec<(usize, usize)> = find_sub(&chars, &qchars).into_iter().map(|s| (s, s + qchars.len())).collect();
    if !exact.is_empty() {
        return pick(exact);
    }

    let (ntext, map) = normalized(text);
    let (nquote, _) = normalized(quote);
    let nquote: Vec<char> = {
        // Trim spaces the collapse may have left at the ends.
        let s: String = nquote.into_iter().collect();
        s.trim().chars().collect()
    };
    let hits: Vec<(usize, usize)> =
        find_sub(&ntext, &nquote).into_iter().map(|s| (map[s], map[s + nquote.len() - 1] + 1)).collect();
    pick(hits)
}

/// The anchor to use for an LLM-supplied quote: the matched range, or `None` (whole paragraph).
pub fn resolve_quote(text: &str, quote: Option<&str>) -> Option<Anchor> {
    quote.and_then(|q| find_anchor(text, q, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_offsets_handle_astral_and_cjk() {
        let t = "a😀b漢c";
        assert_eq!(utf16_prefix(t), vec![0, 1, 3, 4, 5, 6]);
        let a = anchor_from_chars(t, 2, 4);
        assert_eq!((a.start, a.length, a.quote.as_str()), (3, 2, "b漢"));
        assert_eq!(slice_utf16(t, 3, 2).as_deref(), Some("b漢"));
        assert_eq!(slice_utf16(t, 2, 1), None); // middle of surrogate pair
    }

    #[test]
    fn finds_exact_and_nearest() {
        let t = "the cat and the dog";
        assert_eq!(find_anchor(t, "the", None).unwrap().start, 0);
        assert_eq!(find_anchor(t, "the", Some(14)).unwrap().start, 12);
    }

    #[test]
    fn finds_with_smart_quotes_and_whitespace() {
        let t = "He said \u{201C}it\u{2019}s  fine\u{201D} today.";
        let a = find_anchor(t, "\"it's fine\"", None).unwrap();
        assert_eq!(a.quote, "\u{201C}it\u{2019}s  fine\u{201D}");
        assert_eq!(a.start, 8);
    }

    #[test]
    fn case_insensitive_fallback() {
        let a = find_anchor("Climate Change is real", "climate change", None).unwrap();
        assert_eq!((a.start, a.length), (0, 14));
    }

    #[test]
    fn missing_quote() {
        assert!(find_anchor("abc", "xyz", None).is_none());
        assert!(find_anchor("abc", "  ", None).is_none());
    }
}
