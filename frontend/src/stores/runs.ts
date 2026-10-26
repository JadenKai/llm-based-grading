/** Orchestration of server runs (grading, chat) and proposal decisions. */
import { api, streams, type Envelope } from "../api/client";
import type { ModelRef } from "../api/gen/ModelRef";
import type { Paragraph } from "../api/gen/Paragraph";
import type { ThinkSetting } from "../api/gen/ThinkSetting";
import type { Proposal } from "../api/gen/Proposal";
import { extractParagraphs } from "../docx/bridge";
import { cleanText, finalizePreview, locate } from "../docx/previews";
import { useEditorStore } from "../docx/editorStore";
import { useApp } from "./app";

const onEvent = (env: Envelope) => useApp.getState().apply(env);

function reportFailure(e: unknown) {
  const runId = `local_err_${Date.now()}`;
  const message = e instanceof Error ? e.message : String(e);
  const apply = useApp.getState().apply;
  apply({ seq: 0, run_id: runId, type: "run_started", kind: "chat", model: { provider_id: "", model: "" } });
  apply({ seq: 1, run_id: runId, type: "error", message, recoverable: true });
  apply({ seq: 2, run_id: runId, type: "run_finished", status: "failed" });
}

let streaming = false;

export async function startGrading(sessionId: string, paragraphs: Paragraph[], model: ModelRef) {
  if (streaming) return;
  streaming = true;
  // The backend adopts these paragraphs for grading; mirror them so the review panel can group by them.
  useApp.setState((d) => {
    if (d.session) d.session.paragraphs = paragraphs;
  });
  try {
    await streams.grade(sessionId, paragraphs, model, onEvent);
  } catch (e) {
    reportFailure(e);
  } finally {
    streaming = false;
  }
}

export async function sendChat(sessionId: string, text: string, model: ModelRef, think: ThinkSetting | null) {
  if (streaming) return;
  streaming = true;
  useApp.getState().echoUser(text);
  try {
    await streams.chat(sessionId, text, model, think, onEvent);
  } catch (e) {
    useApp.setState((d) => {
      d.items = d.items.filter((it) => !(it.kind === "user" && it.id.startsWith("local_")));
    });
    reportFailure(e);
  } finally {
    streaming = false;
  }
}

/** Re-attach to a run still in progress (e.g. after a page reload). */
export async function attachRun(sessionId: string, runId: string) {
  if (streaming) return;
  streaming = true;
  try {
    await streams.attach(sessionId, runId, onEvent);
  } catch {
    // The run already finished and was dropped; reload the snapshot to get its results.
    const snap = await api.getSession(sessionId);
    useApp.getState().loadSession(snap);
  } finally {
    streaming = false;
  }
}

export async function cancelRun() {
  const { session, activeRunId } = useApp.getState();
  if (session && activeRunId) await api.cancelRun(session.id, activeRunId).catch(() => {});
}

/**
 * Accept or reject a proposal. Suggested fixes are resolved in the editor first (accepted:
 * the fix stays, in normal colour; rejected: the original returns), and the resulting clean
 * paragraph text is sent along so the backend can re-anchor the remaining suggestions.
 */
export async function decide(pid: string, decision: "accept" | "reject", note?: string) {
  const { session } = useApp.getState();
  if (!session) return;
  const proposal = session.proposals.find((p) => p.id === pid);
  if (!proposal) return;
  let paragraph_text: string | undefined;
  const ann = proposal.annotation;
  if (ann.kind === "edit") {
    const { editor } = useEditorStore.getState();
    if (!editor) throw new Error("The document is not ready yet.");
    const sameParagraph = (p: Proposal) => p.annotation.para === ann.para;
    const block = extractParagraphs(editor).blocks.get(ann.para);
    const l = block && locate(block.text, session.proposals.filter(sameParagraph)).find((x) => x.proposal.id === pid);
    const err = block && l ? finalizePreview(editor, block, l, decision === "accept") : "the paragraph was not found";
    if (err && decision === "accept") throw new Error(`Could not apply the fix: ${err}`);
    const fresh = extractParagraphs(editor);
    useEditorStore.getState().setBlocks(fresh.blocks);
    const text = fresh.blocks.get(ann.para)?.text;
    if (decision === "accept" && text !== undefined) {
      const others = session.proposals.filter((p) => p.id !== pid && sameParagraph(p));
      paragraph_text = cleanText(text, locate(text, others));
    }
  }
  const resp = await api.decide(session.id, pid, { decision, note, paragraph_text });
  useApp.getState().applyDecision(resp);
}

/** Decide many proposals sequentially (edits shift offsets, so order matters). */
export async function decideAll(pids: string[], decision: "accept" | "reject") {
  const errors: string[] = [];
  for (const pid of pids) {
    try {
      await decide(pid, decision);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return errors;
}
