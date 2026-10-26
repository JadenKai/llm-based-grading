# Essay Grader

An agentic essay grader. Pick (or upload) a `.docx` essay and a JSON rubric. The agent then:

- highlights each paragraph on a green → yellow → red scale, from "advances the thesis" to "detracts from it";
- leaves comments;
- suggests grammar fixes using [Harper](https://github.com/automattic/harper), shown inline in red until you accept or reject them;
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

The landing page offers the bundled examples in two dropdowns: essays from `examples/essays/*.docx` and rubrics from `examples/rubrics/*.json` (override the folder with `GRADER_PRESETS_DIR`). See `examples/README.md` for what the grader should find.

## Rubric format

Rubrics are JSON. Only `title`, `criteria[].name` and `criteria[].points` are required:

```json
{
  "title": "Persuasive Essay Rubric",
  "description": "Optional one-line description.",
  "criteria": [
    {
      "name": "Thesis & Focus",
      "points": 5,
      "description": "A clear, arguable thesis that every paragraph serves.",
      "levels": [
        { "label": "Exemplary", "points": 5, "description": "Precise, arguable thesis early on." },
        { "label": "Beginning", "points": 0, "description": "No identifiable thesis." }
      ]
    }
  ],
  "notes": ["Optional grading notes."]
}
```

The total is the sum of the criteria's points. Uploads are validated, and errors name the field to fix.

## How grading works

Grading on upload runs as a fixed pipeline rather than a free-form agent loop, because many open models are unreliable at multi-step tool calling. Each step asks for a JSON object. The expected fields are described in plain words in the prompt, because pasting a raw JSON schema makes some models (e.g. `gemma4`) copy its shape. The schema is also sent as `format` on Ollama and `response_format` on OpenAI-compatible servers, though not every server enforces it. Replies are repaired leniently (code fences, a stray wrapper object) and retried once with a precise correction. Every prompt asks for the shortest useful answer.

1. Read the rubric's criteria (straight from the JSON; no model call).
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

- Comments are shown in the app itself: click a highlighted paragraph, press **Show details**, or open the **Review** tab. They are not written into the exported `.docx`, because native Word comments and tracked changes need docx-editor's commercial Pro package. Highlights are also view-only.
- Suggested fixes are previewed as ordinary red (and struck-through) text, not real tracked changes, for the same reason. **Export** leaves pending previews out.
- Paragraphs are identified by order (`P1`, `P2`, …). Splitting or merging paragraphs by hand after grading can move annotations onto the wrong paragraph.
