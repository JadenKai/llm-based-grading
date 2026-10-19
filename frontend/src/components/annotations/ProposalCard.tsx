import { useState } from "react";
import type { Proposal } from "../../api/gen/Proposal";
import { scoreColorFor, scoreInkFor } from "../../docx/colors";
import { useApp } from "../../stores/app";
import { decide } from "../../stores/runs";

const STATUS_STYLE: Record<Proposal["status"], string> = {
  pending: "bg-amber-50 text-amber-700",
  accepted: "bg-emerald-50 text-emerald-700",
  rejected: "bg-stone-100 text-stone-500",
  stale: "bg-stone-100 text-stone-500",
};

export function ScoreChip({ score }: { score: number }) {
  return (
    <span
      className="inline-block rounded px-1.5 font-mono text-xs font-semibold"
      style={{ background: scoreColorFor(score), color: scoreInkFor(score) }}
    >
      {Math.round(score * 100)}
    </span>
  );
}

export function ProposalBody({ proposal }: { proposal: Proposal }) {
  const a = proposal.annotation;
  const current = useApp((s) =>
    a.kind === "score"
      ? s.session?.annotations.find((x) => x.kind === "score" && x.para === a.para)
      : undefined,
  );
  switch (a.kind) {
    case "score":
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-sm">
            Score {current?.kind === "score" ? <ScoreChip score={current.score} /> : <span>—</span>}
            <span className="text-stone-400">→</span>
            <ScoreChip score={a.score} />
          </div>
          <p className="text-sm text-stone-600">{a.rationale}</p>
        </div>
      );
    case "comment":
      return (
        <div className="space-y-1">
          {a.anchor && <blockquote className="border-l-2 border-sky-300 pl-2 text-xs italic text-stone-500">“{a.anchor.quote}”</blockquote>}
          <p className="text-sm text-stone-700">{a.text}</p>
        </div>
      );
    case "edit":
      return (
        <div className="space-y-1">
          <div className="text-sm">
            <del className="rounded bg-red-50 px-0.5 text-red-700">{a.anchor.quote}</del>{" "}
            <span className="text-stone-400">→</span>{" "}
            <ins className="rounded bg-emerald-50 px-0.5 text-emerald-800 no-underline">
              {a.replacement || <em className="text-stone-400">(remove)</em>}
            </ins>
          </div>
          {a.reason && <p className="text-xs text-stone-500">{a.reason}</p>}
        </div>
      );
  }
}

const KIND_LABEL = { score: "Score change", comment: "Comment", edit: "Edit" } as const;

export function ProposalCard({ proposal, compact = false }: { proposal: Proposal; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const focus = useApp((s) => s.focus);
  const setTab = useApp((s) => s.setTab);
  const focused = useApp((s) => s.focusAnnotation === proposal.annotation.id);
  const a = proposal.annotation;
  const source = a.kind === "edit" && a.source === "harper" ? "Grammar (Harper)" : "Agent";

  const run = async (d: "accept" | "reject", n?: string) => {
    setBusy(true);
    setError(null);
    try {
      await decide(proposal.id, d, n);
      setRejecting(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`rounded-lg border bg-white p-2.5 shadow-sm transition ${
        focused ? "border-amber-400 ring-2 ring-amber-200" : "border-stone-200"
      }`}
      onClick={() => {
        setTab("essay");
        focus(a.para, a.id);
      }}
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px]">
        <span className="font-mono font-semibold text-stone-600">{a.para}</span>
        <span className="text-stone-400">·</span>
        <span className="text-stone-500">{KIND_LABEL[a.kind]}</span>
        {!compact && <span className="text-stone-400">· {source}</span>}
        <span className={`ml-auto rounded px-1.5 py-0.5 font-medium ${STATUS_STYLE[proposal.status]}`}>
          {proposal.status === "pending" ? "needs review" : proposal.status}
        </span>
      </div>
      <ProposalBody proposal={proposal} />
      {proposal.note && <p className="mt-1 text-xs text-stone-500">Note: {proposal.note}</p>}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      {proposal.status === "pending" && (
        <div className="mt-2 space-y-1.5" onClick={(e) => e.stopPropagation()}>
          {rejecting && (
            <input
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run("reject", note)}
              placeholder="Why? (optional, shared with the agent)"
              className="w-full rounded border border-stone-200 px-2 py-1 text-xs outline-none focus:border-stone-400"
            />
          )}
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => run("accept")}
              className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Accept
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => (rejecting ? run("reject", note) : setRejecting(true))}
              className="rounded-md border border-stone-300 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
            >
              {rejecting ? "Confirm reject" : "Reject"}
            </button>
            {error && a.kind === "edit" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => run("reject", "could not be applied")}
                className="ml-auto text-xs text-stone-500 underline"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
