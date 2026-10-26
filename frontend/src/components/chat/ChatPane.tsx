import { useEffect, useMemo, useRef, useState } from "react";
import type { Proposal } from "../../api/gen/Proposal";
import type { ThinkSetting } from "../../api/gen/ThinkSetting";
import { useApp, usePrefs } from "../../stores/app";
import type { ChatItem } from "../../stores/applyEvent";
import { cancelRun, decideAll, sendChat } from "../../stores/runs";
import { ProposalCard } from "../annotations/ProposalCard";
import { Markdown } from "../Markdown";
import { ModelPicker } from "../ModelPicker";
import { StepRow } from "./StepRow";

const NO_PROPOSALS: Proposal[] = [];

function ProposalsBlock({ ids }: { ids: string[] }) {
  const proposals = useApp((s) => s.session?.proposals ?? NO_PROPOSALS);
  const items = ids.map((id) => proposals.find((p) => p.id === id)).filter((p) => p !== undefined);
  return (
    <div className="space-y-2 py-1">
      {items.map((p) => (
        <ProposalCard key={p.id} proposal={p} />
      ))}
    </div>
  );
}

function AssistantMessage({ item }: { item: Extract<ChatItem, { kind: "assistant" }> }) {
  const empty = item.blocks.length === 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px] text-stone-400">
        <span className="font-semibold text-stone-500">{item.runKind === "grade" ? "Grading" : "Assistant"}</span>
        {item.model?.model && <span className="font-mono">{item.model.model}</span>}
        {item.usage.completion > 0 && (
          <span title="prompt / completion tokens">
            {item.usage.prompt.toLocaleString()} → {item.usage.completion.toLocaleString()} tok
          </span>
        )}
        {item.status === "cancelled" && <span className="text-stone-500">· stopped</span>}
        {item.status === "failed" && <span className="text-red-500">· failed</span>}
      </div>
      {empty && item.status === "running" && <div className="text-sm text-stone-400">Starting…</div>}
      {item.blocks.map((b, i) => {
        switch (b.type) {
          case "step":
            return <StepRow key={b.stepId} id={b.stepId} />;
          case "text":
            return <Markdown key={b.messageId + i} className="text-sm text-stone-800">{b.text}</Markdown>;
          case "proposals":
            return <ProposalsBlock key={`p${i}`} ids={b.ids} />;
          case "error":
            return (
              <div
                key={`e${i}`}
                className={`rounded-md px-2.5 py-1.5 text-xs ${
                  b.recoverable ? "bg-amber-50 text-amber-800" : "bg-red-50 text-red-700"
                }`}
              >
                {b.message}
              </div>
            );
        }
      })}
    </div>
  );
}

const THINK_OPTIONS: { value: ThinkSetting | null; label: string }[] = [
  { value: null, label: "Think: model default" },
  { value: "off", label: "Think: off" },
  { value: "on", label: "Think: on" },
  { value: "low", label: "Think: low" },
  { value: "medium", label: "Think: medium" },
  { value: "high", label: "Think: high" },
];

const SUGGESTIONS = [
  "Why did paragraph P2 get its score?",
  "Which rubric criterion is weakest, and how could the student improve it?",
  "Check the grammar of the conclusion and propose fixes.",
  "Fact-check the essay's main statistic.",
];

function Composer() {
  const session = useApp((s) => s.session);
  const running = useApp((s) => s.activeRunId !== null);
  const { model, think, setThink } = usePrefs();
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const proposals = useApp((s) => s.session?.proposals);
  // Agent proposals only; grammar fixes are reviewed in the Review tab.
  const pending = useMemo(
    () =>
      (proposals ?? []).filter(
        (p) => p.status === "pending" && !(p.annotation.kind === "edit" && p.annotation.source === "harper"),
      ),
    [proposals],
  );

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  const canSend = !!session && !!model && !running && text.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    const t = text.trim();
    setText("");
    sendChat(session!.id, t, model!, think);
  };

  return (
    <div className="border-t border-stone-200 bg-white p-3">
      {pending.length > 0 && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          <span>{pending.length} agent proposal(s) awaiting your review</span>
          <button
            type="button"
            className="ml-auto font-medium hover:underline"
            onClick={() => decideAll(pending.map((p) => p.id), "accept")}
          >
            Accept all
          </button>
          <button type="button" className="hover:underline" onClick={() => decideAll(pending.map((p) => p.id), "reject")}>
            Reject all
          </button>
        </div>
      )}
      <div className="rounded-2xl border border-stone-300 bg-white shadow-sm focus-within:border-stone-400">
        <textarea
          ref={taRef}
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={session?.graded ? "Ask about the essay, rubric or grade…" : "Ask a question (grading in progress)…"}
          className="block w-full resize-none rounded-t-2xl bg-transparent px-4 pt-3 pb-1 text-sm outline-none"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <ModelPicker />
          <select
            value={think ?? ""}
            onChange={(e) => setThink((e.target.value || null) as ThinkSetting | null)}
            className="rounded-lg bg-transparent px-1 py-1 text-xs text-stone-500 outline-none hover:bg-stone-100"
            title="Reasoning effort (for models that support thinking)"
          >
            {THINK_OPTIONS.map((o) => (
              <option key={o.label} value={o.value ?? ""}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="ml-auto">
            {running ? (
              <button
                type="button"
                onClick={cancelRun}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-stone-800 text-white hover:bg-stone-700"
                title="Stop"
              >
                <span className="block h-2.5 w-2.5 rounded-[2px] bg-white" />
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-stone-800 text-white hover:bg-stone-700 disabled:bg-stone-300"
                title="Send (Enter)"
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
      {!model && <p className="mt-1 text-xs text-red-600">No model available — configure a provider in Settings.</p>}
    </div>
  );
}

export function ChatPane() {
  const items = useApp((s) => s.items);
  const steps = useApp((s) => s.steps);
  const session = useApp((s) => s.session);
  const running = useApp((s) => s.activeRunId !== null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { model, think } = usePrefs();

  // Follow the stream unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, steps]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="flex-1 space-y-5 overflow-y-auto px-4 py-4"
      >
        {items.map((it) =>
          it.kind === "user" ? (
            <div key={it.id} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-stone-100 px-3.5 py-2 text-sm text-stone-800">
                {it.text}
              </div>
            </div>
          ) : (
            <AssistantMessage key={it.runId} item={it} />
          ),
        )}
        {session?.graded && !running && items.filter((i) => i.kind === "user").length === 0 && (
          <div className="space-y-1.5">
            <p className="text-xs text-stone-400">Try asking:</p>
            {SUGGESTIONS.map((s) => (
              <button
                type="button"
                key={s}
                disabled={!model}
                onClick={() => sendChat(session.id, s, model!, think)}
                className="block w-full rounded-lg border border-stone-200 px-3 py-1.5 text-left text-sm text-stone-600 hover:bg-stone-50"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
      <Composer />
    </div>
  );
}
