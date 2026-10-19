//! Lenient JSON extraction for models that wrap output in prose or code fences.

use serde_json::Value;

pub fn parse_lenient(raw: &str) -> Option<Value> {
    let s = raw.trim();
    if let Ok(v) = serde_json::from_str::<Value>(s) {
        return Some(v);
    }
    let s = strip_fences(s);
    if let Ok(v) = serde_json::from_str::<Value>(s) {
        return Some(v);
    }
    let candidate = first_balanced(s)?;
    serde_json::from_str::<Value>(candidate)
        .ok()
        .or_else(|| serde_json::from_str::<Value>(&remove_trailing_commas(candidate)).ok())
}

fn strip_fences(s: &str) -> &str {
    let Some(start) = s.find("```") else { return s };
    let after = &s[start + 3..];
    let after = after.trim_start_matches(|c: char| c.is_ascii_alphanumeric());
    match after.find("```") {
        Some(end) => after[..end].trim(),
        None => after.trim(),
    }
}

/// The first balanced `{…}` or `[…]`, respecting strings.
fn first_balanced(s: &str) -> Option<&str> {
    let start = s.find(['{', '['])?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for (i, c) in s[start..].char_indices() {
        if in_str {
            match c {
                _ if esc => esc = false,
                '\\' => esc = true,
                '"' => in_str = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' | '[' => depth += 1,
            '}' | ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[start..start + i + c.len_utf8()]);
                }
            }
            _ => {}
        }
    }
    None
}

fn remove_trailing_commas(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut in_str = false;
    let mut esc = false;
    for (i, &c) in chars.iter().enumerate() {
        if in_str {
            out.push(c);
            match c {
                _ if esc => esc = false,
                '\\' => esc = true,
                '"' => in_str = false,
                _ => {}
            }
            continue;
        }
        if c == '"' {
            in_str = true;
        }
        if c == ',' {
            let next = chars[i + 1..].iter().find(|c| !c.is_whitespace());
            if matches!(next, Some('}') | Some(']')) {
                continue;
            }
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plain() {
        assert_eq!(parse_lenient(r#"{"a":1}"#), Some(json!({"a":1})));
    }

    #[test]
    fn fenced_and_prose() {
        let raw = "Sure! Here you go:\n```json\n{\"a\": [1, 2,],}\n```\nHope it helps";
        assert_eq!(parse_lenient(raw), Some(json!({"a":[1,2]})));
    }

    #[test]
    fn braces_inside_strings() {
        let raw = r#"result: {"t": "a } b", "n": {"x": 2}} trailing"#;
        assert_eq!(parse_lenient(raw), Some(json!({"t":"a } b","n":{"x":2}})));
    }

    #[test]
    fn garbage() {
        assert_eq!(parse_lenient("no json here"), None);
    }
}
