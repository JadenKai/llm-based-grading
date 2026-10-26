# Examples

These files are offered in the landing page's dropdowns.

| File | What it is |
|---|---|
| `essays/fare-free-transit.docx` | A ~450-word argumentative essay: *Fare-Free Transit: A Ticket to Fairer Cities* |
| `essays/four-day-school-week.docx` | A short persuasive essay: *The Case for Four-Day School Weeks* |
| `rubrics/argumentative.json` | 25-point argumentative essay rubric with level descriptors |
| `rubrics/persuasive.json` | 20-point persuasive essay rubric |
| `rubrics/ap-lang-argument.json` | 6-point rubric modeled on the AP Language argument essay |

Drop more `.docx` files into `essays/` or JSON rubrics into `rubrics/` and they appear in the dropdowns. Essays are listed by their document title (the file name if it has none). See the main README for the rubric format.

## What the grader should find in *Fare-Free Transit*

Paragraph keys count every non-empty paragraph, so the title is P1 and the byline P2.

| Paragraph | What to expect |
|---|---|
| P1, P2 (title, byline) | Not scored, because they are treated as headings. |
| P3 (intro), P4 (fairness, Tallinn) | Strong: green. |
| P5 (environment) | Supports the thesis but has grammar slips: *more people leaves*, *effects* for *affects*, *Their are*, *a era*, *can not*. |
| P6 (cost) | Contains a **factual error**: Kansas City went fare-free in 2020, not 2012. The Luxembourg claim (nationwide free transit in 2020) is accurate. With an Ollama API key set, the fact-check step should flag the Kansas City date. |
| P7 (train anecdote) | An off-topic personal digression: should be yellow or red. |
| P8 (counterargument) | A reasonable rebuttal of the overcrowding concern. |
| P9 (conclusion) | Adequate, with *there* for *their*. |

Harper catches *Their are*, *a era* and *there residents* on its own; they appear in red in the essay as suggested fixes. It also flags the author's surname as a spelling error, which you can simply reject. The remaining slips (*leaves*, *effects*, *can not*) are left for the LLM: ask the chat agent to check P5's grammar and it will propose edits for your approval.

`fixtures/` holds a smaller essay and rubric used for testing.
