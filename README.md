# Essay Grader

An agentic essay grader. Upload a `.docx` essay and a Markdown rubric. The agent then:

- highlights each paragraph on a green → yellow → red scale, from "advances the thesis" to "detracts from it";
- leaves comments;
- suggests grammar fixes using [Harper](https://github.com/automattic/harper);
- fact-checks claims with web search;
- scores the essay against the rubric.

You can then discuss the grade with the agent in a chat. Every tool call and pipeline step is shown live in that chat. Any change the agent proposes waits for your approval.

- **frontend/**: React + TypeScript (Vite). The essay is rendered with [docx-editor](https://github.com/eigenpal/docx-editor), using only the Apache-2.0 `@docx-editor.dev/react` and `@docx-editor.dev/core` packages.
- **backend/**: Rust (axum). It runs the agent loop, the grading pipeline, Harper grammar checks, and providers for Ollama (local and Cloud) and OpenAI-compatible servers.

## Running

```sh
nix develop          # or have cargo, node/bun and just installed
just install
just dev             # backend on 127.0.0.1:8080, UI on http://localhost:5173
```

Open **Settings** to configure model providers:

- **Ollama (local)**: defaults to `http://127.0.0.1:11434`.
- **Ollama Cloud**: paste an API key from <https://ollama.com/settings/keys> to use large hosted models. The same key enables web-search fact-checking. Alternatively, set `OLLAMA_API_KEY` in the backend's environment.
- **OpenAI-compatible**: vLLM, llama.cpp server, LM Studio, OpenRouter, and similar. The base URL must include `/v1`.

API keys stay on the backend. They are stored in `~/.config/llm-grading/settings.json` with mode 0600 and are never returned to the browser. Sessions are saved in `~/.local/share/llm-grading/sessions/`. You can override these locations with `GRADER_CONFIG_DIR` and `GRADER_DATA_DIR`, and the listen address with `GRADER_ADDR`.

Try it with the example essay and rubric in `examples/` (see `examples/README.md` for what the grader should find).

## How grading works

Grading on upload runs as a fixed pipeline rather than a free-form agent loop, because many open models are unreliable at multi-step tool calling. Each step makes a model call constrained by a JSON schema (`format` on Ollama, `response_format` on OpenAI-compatible servers). Output is repaired leniently and retried once if it doesn't parse.

1. Read the rubric's criteria.
2. Run Harper on every paragraph. Fixes become pending suggestions; issues with no fix become comments.
3. Identify the thesis.
4. Score each body paragraph from 0 to 100 for how much it supports the thesis, and add comments anchored to exact quotes. Titles and headings are skipped.
5. Fact-check up to N claims with `ollama.com/api/web_search` (only when an Ollama key is configured).
6. Write the rubric assessment. This becomes the frozen **Original Assessment**.

The **chat** agent runs a tool loop with these tools: `get_rubric`, `list_paragraphs`, `get_paragraph`, `get_assessment`, `check_grammar`, `web_search`, `web_fetch`, `list_proposals`, `set_paragraph_score`, `add_comment` and `propose_edit`. The annotation tools only create *proposals*. Accepting an edit applies it in the document. Your decisions, including any note you add when rejecting, are passed to the agent at the start of its next turn.

Runs are decoupled from HTTP requests. If you reload the page mid-run, the UI re-attaches and replays the run's events.

## Development

```sh
just test        # cargo test (offsets, JSON repair, provider streams via wiremock, Harper, …) + vitest + tsc
just gen-types   # regenerate frontend/src/api/gen/*.ts from the Rust types (ts-rs)
```

## Known limitations

- Comments and suggestions are shown in the app's own review panel. They are not written into the exported `.docx`, because native Word comments and tracked changes need docx-editor's commercial Pro package. Highlights are also view-only.
- Paragraphs are identified by order (`P1`, `P2`, …). Splitting or merging paragraphs by hand after grading can move annotations onto the wrong paragraph.
