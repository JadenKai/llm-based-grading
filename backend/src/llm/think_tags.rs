//! Streaming splitter for models that emit reasoning inline as `<think>…</think>`.

use super::ChatChunk;

const OPEN: &str = "<think>";
const CLOSE: &str = "</think>";

#[derive(Default)]
pub struct ThinkSplitter {
    in_think: bool,
    buf: String,
}

impl ThinkSplitter {
    /// Feed a text delta; returns the chunks that are safe to emit now.
    pub fn push(&mut self, delta: &str) -> Vec<ChatChunk> {
        self.buf.push_str(delta);
        let mut out = Vec::new();
        loop {
            let tag = if self.in_think { CLOSE } else { OPEN };
            if let Some(pos) = self.buf.find(tag) {
                let before: String = self.buf[..pos].to_string();
                self.emit(&mut out, before);
                self.buf.drain(..pos + tag.len());
                self.in_think = !self.in_think;
                continue;
            }
            // Hold back a suffix that could be the start of a tag.
            let keep = partial_suffix(&self.buf, tag);
            let flush_to = self.buf.len() - keep;
            let ready: String = self.buf[..flush_to].to_string();
            self.buf.drain(..flush_to);
            self.emit(&mut out, ready);
            return out;
        }
    }

    pub fn finish(&mut self) -> Vec<ChatChunk> {
        let rest = std::mem::take(&mut self.buf);
        let mut out = Vec::new();
        self.emit(&mut out, rest);
        out
    }

    fn emit(&self, out: &mut Vec<ChatChunk>, s: String) {
        if s.is_empty() {
            return;
        }
        out.push(if self.in_think { ChatChunk::Thinking(s) } else { ChatChunk::Text(s) });
    }
}

fn partial_suffix(buf: &str, tag: &str) -> usize {
    (1..tag.len().min(buf.len() + 1))
        .rev()
        .find(|&n| buf.is_char_boundary(buf.len() - n) && tag.starts_with(&buf[buf.len() - n..]))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(parts: &[&str]) -> (String, String) {
        let mut s = ThinkSplitter::default();
        let mut chunks: Vec<ChatChunk> = parts.iter().flat_map(|p| s.push(p)).collect();
        chunks.extend(s.finish());
        let (mut t, mut k) = (String::new(), String::new());
        for c in chunks {
            match c {
                ChatChunk::Text(x) => t.push_str(&x),
                ChatChunk::Thinking(x) => k.push_str(&x),
                _ => {}
            }
        }
        (t, k)
    }

    #[test]
    fn splits_across_deltas() {
        let (t, k) = run(&["<thi", "nk>reason", "ing</th", "ink>Answer"]);
        assert_eq!(k, "reasoning");
        assert_eq!(t, "Answer");
    }

    #[test]
    fn no_tags() {
        assert_eq!(run(&["hello <b>", "world"]).0, "hello <b>world");
    }

    #[test]
    fn trailing_lt_is_flushed_at_end() {
        assert_eq!(run(&["a <"]).0, "a <");
    }
}
