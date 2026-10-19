# Examples

| File | What it is |
|---|---|
| `transit-essay.docx` | A ~450-word argumentative essay: *Fare-Free Transit: A Ticket to Fairer Cities* |
| `argumentative-rubric.md` | A 25-point argumentative essay rubric with level descriptors |

Upload both on the start screen to try the grader.

## What the grader should find

The essay deliberately mixes strong and weak writing, so a good run should produce a visible spread of highlight colours.

| Paragraph | What to expect |
|---|---|
| Title and byline | Not scored, because they are treated as headings. |
| P3 (intro), P4 (fairness, Tallinn) | Strong: green. |
| P5 (environment) | Supports the thesis but has grammar slips: *more people leaves*, *effects* for *affects*, *Their are*, *a era*, *can not*. |
| P6 (cost) | Contains a **factual error**: Kansas City went fare-free in 2020, not 2012. The Luxembourg claim (nationwide free transit in 2020) is accurate. With an Ollama API key set, the fact-check step should flag the Kansas City date. |
| P7 (train anecdote) | An off-topic personal digression: should be yellow or red. |
| P8 (counterargument) | A reasonable rebuttal of the overcrowding concern. |
| P9 (conclusion) | Adequate, with *there* for *their*. |

Harper catches *Their are*, *a era* and *there residents* on its own, and also flags the author's surname as a spelling error, which you can simply reject. The remaining slips (*leaves*, *effects*, *can not*) are left for the LLM: ask the chat agent to check P5's grammar and it will propose edits for your approval.

`fixtures/` holds a smaller essay and rubric used for testing.
