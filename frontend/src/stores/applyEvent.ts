import type { Envelope } from "../api/client";
import type { Annotation } from "../api/gen/Annotation";
import type { Assessment } from "../api/gen/Assessment";
import type { ModelRef } from "../api/gen/ModelRef";
import type { Paragraph } from "../api/gen/Paragraph";
import type { Proposal } from "../api/gen/Proposal";
import type { Rubric } from "../api/gen/Rubric";
import type { RunKind } from "../api/gen/RunKind";
import type { SessionSnapshot } from "../api/gen/SessionSnapshot";
import type { StepKind } from "../api/gen/StepKind";
import type { JsonValue } from "../api/gen/serde_json/JsonValue";

export interface ToolCallView {
  callId: string;
  name: string;
  arguments: JsonValue;
  result?: { ok: boolean; summary: string; data: JsonValue | null };
}

export interface StepNode {
  id: string;
  parentId: string | null;
  kind: StepKind;
  label: string;
  detail: string | null;
  status: "running" | "ok" | "error" | "skipped" | "cancelled";
  summary: string | null;
  thinking: string;
  toolCalls: ToolCallView[];
  children: string[];
}

export type Block =
  | { type: "step"; stepId: string }
  | { type: "text"; messageId: string; text: string }
  | { type: "proposals"; ids: string[] }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "verdict"; assessment: Assessment };

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      runId: string;
      runKind: RunKind;
      model: ModelRef | null;
      blocks: Block[];
      status: "running" | "completed" | "failed" | "cancelled";
      usage: { prompt: number; completion: number };
    };

export interface SessionData {
  id: string;
  essayName: string;
  rubricName: string;
  rubricMd: string;
  rubric: Rubric | null;
  paragraphs: Paragraph[];
  annotations: Annotation[];
  /** Ordered by creation. */
  proposals: Proposal[];
  thesis: string | null;
  assessment: Assessment | null;
  graded: boolean;
  model: ModelRef | null;
}

export interface AppData {
  session: SessionData | null;
  items: ChatItem[];
  steps: Record<string, StepNode>;
  activeRunId: string | null;
  lastSeq: Record<string, number>;
}

export const emptyData = (): AppData => ({ session: null, items: [], steps: {}, activeRunId: null, lastSeq: {} });

export function sessionFromSnapshot(s: SessionSnapshot): SessionData {
  return {
    id: s.id,
    essayName: s.essay_name,
    rubricName: s.rubric_name,
    rubricMd: s.rubric_md,
    rubric: s.rubric,
    paragraphs: s.paragraphs,
    annotations: s.annotations,
    proposals: s.proposals,
    thesis: s.thesis,
    assessment: s.original_assessment,
    graded: s.graded,
    model: s.model,
  };
}

function assistantFor(d: AppData, runId: string) {
  for (let i = d.items.length - 1; i >= 0; i--) {
    const it = d.items[i];
    if (it.kind === "assistant" && it.runId === runId) return it;
  }
  return undefined;
}

function upsertProposal(s: SessionData, p: Proposal) {
  const i = s.proposals.findIndex((x) => x.id === p.id);
  if (i >= 0) s.proposals[i] = p;
  else s.proposals.push(p);
}

function applyAnnotation(s: SessionData, a: Annotation) {
  if (a.kind === "score") {
    s.annotations = s.annotations.filter((x) => !(x.kind === "score" && x.para === a.para));
  }
  s.annotations = s.annotations.filter((x) => x.id !== a.id);
  s.annotations.push(a);
}

/**
 * Fold one server event into app state. Written for an immer draft (mutating), and
 * idempotent per (run, seq) so a replayed backlog after re-attaching is harmless.
 */
export function applyEvent(d: AppData, env: Envelope, opts: { chatOnly?: boolean } = {}): void {
  const last = d.lastSeq[env.run_id] ?? -1;
  if (env.seq <= last) return;
  d.lastSeq[env.run_id] = env.seq;

  const item = assistantFor(d, env.run_id);
  // When replaying history the session already holds the final state (e.g. accepted
  // proposals), so only the chat view is rebuilt.
  const s = opts.chatOnly ? null : d.session;

  switch (env.type) {
    case "run_started": {
      d.activeRunId = env.run_id;
      if (!item) {
        d.items.push({
          kind: "assistant",
          runId: env.run_id,
          runKind: env.kind,
          model: env.model,
          blocks: [],
          status: "running",
          usage: { prompt: 0, completion: 0 },
        });
      }
      break;
    }
    case "user_message": {
      const id = `${env.run_id}_u`;
      if (d.items.some((it) => it.kind === "user" && it.id === id)) break;
      // The optimistic local echo is replaced by the server's copy.
      d.items = d.items.filter((it) => !(it.kind === "user" && it.id.startsWith("local_")));
      const userItem: ChatItem = { kind: "user", id, text: env.text };
      // Insert before this run's assistant item.
      const at = d.items.findIndex((it) => it.kind === "assistant" && it.runId === env.run_id);
      if (at >= 0) d.items.splice(at, 0, userItem);
      else d.items.push(userItem);
      break;
    }
    case "step_started": {
      d.steps[env.step_id] = {
        id: env.step_id,
        parentId: env.parent_id,
        kind: env.kind,
        label: env.label,
        detail: null,
        status: "running",
        summary: null,
        thinking: "",
        toolCalls: [],
        children: [],
      };
      if (env.parent_id && d.steps[env.parent_id]) {
        d.steps[env.parent_id].children.push(env.step_id);
      } else {
        item?.blocks.push({ type: "step", stepId: env.step_id });
      }
      break;
    }
    case "step_updated": {
      const st = d.steps[env.step_id];
      if (st) {
        if (env.label) st.label = env.label;
        if (env.detail) st.detail = env.detail;
      }
      break;
    }
    case "step_finished": {
      const st = d.steps[env.step_id];
      if (st) {
        st.status = env.status;
        st.summary = env.summary;
      }
      break;
    }
    case "thinking_delta": {
      const st = d.steps[env.block_id];
      if (st) st.thinking += env.text;
      break;
    }
    case "text_delta": {
      if (!item) break;
      const lastBlock = item.blocks[item.blocks.length - 1];
      if (lastBlock?.type === "text" && lastBlock.messageId === env.message_id) {
        lastBlock.text += env.text;
      } else {
        item.blocks.push({ type: "text", messageId: env.message_id, text: env.text });
      }
      break;
    }
    case "tool_call": {
      const st = d.steps[env.step_id];
      st?.toolCalls.push({ callId: env.call_id, name: env.name, arguments: env.arguments });
      break;
    }
    case "tool_result": {
      for (const st of Object.values(d.steps)) {
        const tc = st.toolCalls.find((t) => t.callId === env.call_id);
        if (tc) {
          tc.result = { ok: env.ok, summary: env.summary, data: env.data };
          break;
        }
      }
      break;
    }
    case "grammar_lints": {
      if (s) for (const p of env.proposals) upsertProposal(s, p);
      break;
    }
    case "annotation_applied": {
      if (s) applyAnnotation(s, env.annotation);
      break;
    }
    case "proposal_created": {
      if (s) upsertProposal(s, env.proposal);
      if (item) {
        const lastBlock = item.blocks[item.blocks.length - 1];
        if (lastBlock?.type === "proposals") lastBlock.ids.push(env.proposal.id);
        else item.blocks.push({ type: "proposals", ids: [env.proposal.id] });
      }
      break;
    }
    case "assessment": {
      // The chat shows the verdict as a widget (kept with the item, so replay works too).
      if (env.original) item?.blocks.push({ type: "verdict", assessment: env.assessment });
      if (s && env.original && !s.assessment) {
        s.assessment = env.assessment;
        s.thesis = env.assessment.thesis;
      }
      if (s) s.graded = true;
      break;
    }
    case "usage": {
      if (item) {
        item.usage.prompt += env.prompt_tokens ?? 0;
        item.usage.completion += env.completion_tokens ?? 0;
      }
      break;
    }
    case "error": {
      item?.blocks.push({ type: "error", message: env.message, recoverable: env.recoverable });
      break;
    }
    case "run_finished": {
      if (item) item.status = env.status;
      if (d.activeRunId === env.run_id) d.activeRunId = null;
      // Anything still spinning was interrupted.
      for (const st of Object.values(d.steps)) {
        if (st.status === "running") st.status = env.status === "completed" ? "ok" : "cancelled";
      }
      break;
    }
  }
}

/** Rebuild chat state from a session snapshot's transcript. */
export function replay(d: AppData, transcript: Envelope[]) {
  for (const env of transcript) applyEvent(d, env, { chatOnly: true });
}
