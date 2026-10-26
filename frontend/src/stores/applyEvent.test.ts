import { produce } from "immer";
import { describe, expect, it } from "vitest";
import type { Envelope } from "../api/client";
import type { Event } from "../api/gen/Event";
import type { Proposal } from "../api/gen/Proposal";
import { bucket, bucketHue } from "../docx/colors";
import { type AppData, applyEvent, emptyData, replay } from "./applyEvent";

const session = (): AppData["session"] => ({
  id: "s",
  essayName: "e.docx",
  rubricName: "r.md",
  rubricMd: "# R",
  rubric: null,
  paragraphs: [{ key: "P1", index: 0, text: "Hello world" }],
  annotations: [],
  proposals: [],
  thesis: null,
  assessment: null,
  graded: false,
  model: null,
});

function run(events: Event[], start: AppData = { ...emptyData(), session: session() }, runId = "r1") {
  let seq = 0;
  return events.reduce(
    (d, e) => produce(d, (draft) => applyEvent(draft, { ...e, seq: seq++, run_id: runId } as Envelope)),
    start,
  );
}

const model = { provider_id: "ollama-local", model: "m" };
const proposal = (id: string): Proposal => ({
  id,
  status: "pending",
  note: null,
  annotation: { kind: "comment", id: `a${id}`, para: "P1", anchor: null, text: "c", author: "agent" },
});

describe("applyEvent", () => {
  it("builds a chat turn with nested steps, thinking, tools and text", () => {
    const d = run([
      { type: "run_started", kind: "chat", model },
      { type: "user_message", text: "hi" },
      { type: "step_started", step_id: "s1", parent_id: null, kind: "llm", label: "Thinking" },
      { type: "thinking_delta", block_id: "s1", text: "hmm" },
      { type: "step_finished", step_id: "s1", status: "ok", summary: null },
      { type: "step_started", step_id: "s2", parent_id: null, kind: "web_search", label: "Searching" },
      { type: "step_started", step_id: "s3", parent_id: "s2", kind: "tool", label: "child" },
      { type: "tool_call", call_id: "c1", step_id: "s2", name: "web_search", arguments: { query: "x" } },
      { type: "tool_result", call_id: "c1", ok: true, summary: "3 results", data: null },
      { type: "text_delta", message_id: "m", text: "Hel" },
      { type: "text_delta", message_id: "m", text: "lo" },
      { type: "run_finished", status: "completed" },
    ]);
    expect(d.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    const a = d.items[1];
    if (a.kind !== "assistant") throw new Error();
    expect(a.blocks).toEqual([
      { type: "step", stepId: "s1" },
      { type: "step", stepId: "s2" },
      { type: "text", messageId: "m", text: "Hello" },
    ]);
    expect(d.steps.s1.thinking).toBe("hmm");
    expect(d.steps.s2.children).toEqual(["s3"]);
    expect(d.steps.s2.toolCalls[0].result?.summary).toBe("3 results");
    // Unfinished steps are closed when the run ends.
    expect(d.steps.s3.status).toBe("ok");
    expect(d.activeRunId).toBeNull();
  });

  it("is idempotent for replayed sequence numbers", () => {
    const evs: Event[] = [
      { type: "run_started", kind: "chat", model },
      { type: "text_delta", message_id: "m", text: "A" },
    ];
    const once = run(evs);
    const twice = produce(once, (draft) => {
      applyEvent(draft, { ...evs[1], seq: 1, run_id: "r1" } as Envelope);
    });
    const a = twice.items[0];
    if (a.kind !== "assistant") throw new Error();
    expect(a.blocks).toEqual([{ type: "text", messageId: "m", text: "A" }]);
  });

  it("replaces score annotations per paragraph and tracks proposals", () => {
    const d = run([
      { type: "run_started", kind: "grade", model },
      { type: "annotation_applied", annotation: { kind: "score", id: "a1", para: "P1", score: 0.2, rationale: "" } },
      { type: "annotation_applied", annotation: { kind: "score", id: "a2", para: "P1", score: 0.9, rationale: "" } },
      { type: "proposal_created", proposal: proposal("p1") },
    ]);
    expect(d.session!.annotations).toHaveLength(1);
    expect(d.session!.annotations[0].id).toBe("a2");
    expect(d.session!.proposals.map((p) => p.id)).toEqual(["p1"]);
  });

  it("replay rebuilds the chat without touching session state", () => {
    const start: AppData = { ...emptyData(), session: { ...session()!, proposals: [{ ...proposal("p1"), status: "accepted" }] } };
    const d = produce(start, (draft) =>
      replay(draft, [
        { seq: 0, run_id: "r", type: "run_started", kind: "chat", model },
        { seq: 1, run_id: "r", type: "proposal_created", proposal: proposal("p1") },
        { seq: 2, run_id: "r", type: "run_finished", status: "completed" },
      ]),
    );
    expect(d.session!.proposals[0].status).toBe("accepted");
    const a = d.items[0];
    if (a.kind !== "assistant") throw new Error();
    expect(a.blocks).toEqual([{ type: "proposals", ids: ["p1"] }]);
  });

  it("keeps the first original assessment", () => {
    const assessment = (overall: number) => ({
      thesis: "t",
      overall,
      max: 10,
      summary: "",
      strengths: [],
      improvements: [],
      criteria: [],
      model,
      created_at: "",
    });
    const d = run([
      { type: "run_started", kind: "grade", model },
      { type: "assessment", assessment: assessment(7), original: true },
      { type: "assessment", assessment: assessment(3), original: true },
    ]);
    expect(d.session!.assessment?.overall).toBe(7);
    expect(d.session!.graded).toBe(true);
  });
});

describe("colour scale", () => {
  it("buckets scores and runs red → yellow → green", () => {
    expect([0, 0.04, 0.05, 0.5, 0.96, 1, 1.4, -1].map(bucket)).toEqual([0, 0, 1, 5, 10, 10, 10, 0]);
    expect(bucketHue(0)).toBe(25);
    expect(bucketHue(5)).toBe(95);
    expect(bucketHue(10)).toBe(145);
    for (let b = 1; b <= 10; b++) expect(bucketHue(b)).toBeGreaterThan(bucketHue(b - 1));
  });
});
