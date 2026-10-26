//! Helpers for structured (JSON) output from models that don't reliably honour a schema.
//!
//! Pasting a raw JSON schema into the prompt makes some models (e.g. gemma4) imitate the
//! schema itself, nesting the answer under `"properties"`. Describing the fields in prose
//! avoids that, and `unwrap_nested` repairs it when it happens anyway.

use serde_json::Value;

fn type_text(v: &Value) -> String {
    let t = v.get("type").and_then(Value::as_str).unwrap_or("value");
    let mut s = match t {
        "array" => match v.get("items") {
            Some(items) if items.get("type").and_then(Value::as_str) == Some("object") => {
                format!("array of objects with keys {}", inline_keys(items))
            }
            Some(items) => format!("array of {}s", type_text(items)),
            None => "array".into(),
        },
        "object" => format!("object with keys {}", inline_keys(v)),
        other => other.to_string(),
    };
    if let Some(vals) = v.get("enum").and_then(Value::as_array) {
        let vals: Vec<String> = vals.iter().filter_map(Value::as_str).map(|x| format!("\"{x}\"")).collect();
        s.push_str(&format!(", one of {}", vals.join(", ")));
    }
    match (v.get("minimum").and_then(Value::as_f64), v.get("maximum").and_then(Value::as_f64)) {
        (Some(lo), Some(hi)) => s.push_str(&format!(" from {lo} to {hi}")),
        (Some(lo), None) => s.push_str(&format!(" ≥ {lo}")),
        (None, Some(hi)) => s.push_str(&format!(" ≤ {hi}")),
        _ => {}
    }
    if let Some(n) = v.get("maxItems").and_then(Value::as_u64) {
        s.push_str(&format!(", at most {n} items"));
    }
    s
}

fn inline_keys(obj: &Value) -> String {
    let Some(props) = obj.get("properties").and_then(Value::as_object) else { return "{}".into() };
    let inner: Vec<String> = props.iter().map(|(k, v)| format!("\"{k}\" ({})", type_text(v))).collect();
    format!("{{{}}}", inner.join(", "))
}

/// The top-level keys of an object schema, one bullet each.
pub fn describe(schema: &Value) -> String {
    let Some(props) = schema.get("properties").and_then(Value::as_object) else { return String::new() };
    props
        .iter()
        .map(|(k, v)| {
            let desc = v.get("description").and_then(Value::as_str).map(|d| format!(" — {d}")).unwrap_or_default();
            format!("- \"{k}\": {}{desc}", type_text(v))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn required_keys(schema: &Value) -> Vec<String> {
    schema
        .get("required")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// If the required keys are missing at the top level but present together in a nested object
/// (e.g. the model answered `{"properties": {...}}`), return that object instead.
pub fn unwrap_nested(v: Value, required: &[String]) -> Value {
    let has_all =
        |o: &serde_json::Map<String, Value>| !required.is_empty() && required.iter().all(|k| o.contains_key(k));
    match &v {
        Value::Object(o) if !has_all(o) => {
            o.values().find(|inner| inner.as_object().is_some_and(has_all)).cloned().unwrap_or(v)
        }
        _ => v,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn paragraph_schema() -> Value {
        json!({"type": "object", "properties": {
            "role": {"type": "string", "description": "introduction or evidence"},
            "score": {"type": "integer", "minimum": 0, "maximum": 100},
            "comments": {"type": "array", "maxItems": 2, "items": {"type": "object", "properties": {
                "quote": {"type": "string"}, "comment": {"type": "string"}}}},
            "verdict": {"type": "string", "enum": ["supported", "contradicted"]}
        }, "required": ["role", "score", "comments"]})
    }

    #[test]
    fn describes_fields_in_prose() {
        let d = describe(&paragraph_schema());
        assert!(d.contains("- \"score\": integer from 0 to 100"), "{d}");
        assert!(d.contains("- \"role\": string — introduction or evidence"), "{d}");
        assert!(
            d.contains("array of objects with keys {\"comment\" (string), \"quote\" (string)}, at most 2 items"),
            "{d}"
        );
        assert!(d.contains("one of \"supported\", \"contradicted\""), "{d}");
        assert!(!d.contains("\"properties\""));
    }

    #[test]
    fn unwraps_answer_nested_under_properties() {
        // What gemma4:31b actually returned for a paragraph-scoring request.
        let v = json!({"properties": {"comments": [], "rationale": "Strong.", "role": "introduction", "score": 98}});
        let req = required_keys(&paragraph_schema());
        assert_eq!(unwrap_nested(v, &req)["score"], 98);
        let ok = json!({"role": "x", "score": 1, "comments": []});
        assert_eq!(unwrap_nested(ok.clone(), &req), ok);
        let unrelated = json!({"a": {"b": 1}});
        assert_eq!(unwrap_nested(unrelated.clone(), &req), unrelated);
    }
}
