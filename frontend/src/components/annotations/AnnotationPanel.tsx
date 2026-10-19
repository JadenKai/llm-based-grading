import { useEffect, useMemo, useRef, useState } from "react";
import type { Annotation } from "../../api/gen/Annotation";
import type { Proposal } from "../../api/gen/Proposal";
import { scoreLabel } from "../../docx/colors";
import { useApp } from "../../stores/app";
import { decideAll } from "../../stores/runs";
import { ProposalCard, ScoreChip } from "./ProposalCard";

type Filter = "all" | "pending" | "comments";

const AUTHOR_LABEL = { agent: "Grader", grammar: "Grammar", fact_check: "Fact-check" } as const;

function CommentCard({ a }: { a: Extract<Annotation, { kind: "comment" }> }) {
  const focus = useApp((s) => s.focus);
  const focused = useApp((s) => s.focusAnnotation === a.id);
  const tone =
    a.author === "fact_check" ? "border-l-orange-400" : a.author === "grammar" ? "border-l-rose-300" : "border-l-sky-400";
  return (
    <div
      onClick={() => focus(a.para, a.id)}
      className={`cursor-pointer rounded-lg border border-l-4 bg-white p-2.5 shadow-sm ${tone} ${
        focused ? "border-amber-400 ring-2 ring-amber-200" : "border-stone-200"
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-stone-500">
        <span className="font-mono font-semibold text-stone-600">{a.para}</span>· {AUTHOR_LABEL[a.author]}
      </div>
      {a.anchor && <blockquote className="mb-1 border-l-2 border-stone-200 pl-2 text-xs italic text-stone-500">“{a.anchor.quote}”</blockquote>}
      <p className="text-sm text-stone-700">{a.text}</p>
    </div>
  );
}

export function AnnotationPanel() {
  const session = useApp((s) => s.session);
  const focusAnnotation = useApp((s) => s.focusAnnotation);
  const focusPara = useApp((s) => s.focusPara);
  const focus = useApp((s) => s.focus);
  const [filter, setFilter] = useState<Filter>("all");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    if (!session) return [];
    return session.paragraphs
      .map((p) => {
        const score = session.annotations.find((a) => a.kind === "score" && a.para === p.key) as
          | Extract<Annotation, { kind: "score" }>
          | undefined;
        const comments = session.annotations.filter(
          (a): a is Extract<Annotation, { kind: "comment" }> => a.kind === "comment" && a.para === p.key,
        );
        const proposals = session.proposals.filter((x) => x.annotation.para === p.key);
        return { p, score, comments, proposals };
      })
      .filter((g) => g.score || g.comments.length || g.proposals.length);
  }, [session]);

  // Bring the focused item into view when it is selected in the document.
  useEffect(() => {
    const id = focusAnnotation ?? (focusPara ? `para-${focusPara}` : null);
    if (!id) return;
    listRef.current?.querySelector(`[data-ann="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focusAnnotation, focusPara]);

  if (!session) return null;
  const pending = session.proposals.filter((p) => p.status === "pending");
  const pendingGrammar = pending.filter((p) => p.annotation.kind === "edit" && p.annotation.source === "harper");

  const visibleProposal = (p: Proposal) =>
    filter === "all" ? p.status !== "rejected" : filter === "pending" ? p.status === "pending" : false;

  const bulk = async (ids: string[], d: "accept" | "reject") => {
    setBulkBusy(true);
    setBulkErrors(await decideAll(ids, d));
    setBulkBusy(false);
  };

  return (
    <div className="flex h-full flex-col border-l border-stone-200 bg-stone-50">
      <div className="space-y-2 border-b border-stone-200 p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-stone-800">Review</h3>
          <span className="text-xs text-stone-500">{pending.length} pending</span>
        </div>
        <div className="flex gap-1 text-xs">
          {(["all", "pending", "comments"] as const).map((f) => (
            <button
              type="button"
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-2.5 py-0.5 capitalize ${
                filter === f ? "bg-stone-800 text-white" : "bg-white text-stone-600 ring-1 ring-stone-200 hover:bg-stone-100"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        {pendingGrammar.length > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-stone-500">{pendingGrammar.length} grammar fixes</span>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => bulk(pendingGrammar.map((p) => p.id), "accept")}
              className="rounded bg-emerald-600 px-2 py-0.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Accept all
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => bulk(pendingGrammar.map((p) => p.id), "reject")}
              className="rounded px-2 py-0.5 text-stone-600 ring-1 ring-stone-300 hover:bg-white disabled:opacity-50"
            >
              Reject all
            </button>
          </div>
        )}
        {bulkErrors.length > 0 && (
          <p className="text-xs text-red-600">
            {bulkErrors.length} could not be applied (left pending). {bulkErrors[0]}
          </p>
        )}
      </div>
      <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto p-3">
        {groups.length === 0 && <p className="text-sm text-stone-500">Annotations appear here as the essay is graded.</p>}
        {groups.map(({ p, score, comments, proposals }) => {
          const shownProposals = proposals.filter(visibleProposal);
          const shownComments = filter === "pending" ? [] : comments;
          if (filter !== "all" && !shownProposals.length && !shownComments.length) return null;
          return (
            <section key={p.key} data-ann={`para-${p.key}`} className="space-y-1.5">
              <button
                type="button"
                onClick={() => focus(p.key, score?.id ?? null)}
                className={`flex w-full items-center gap-2 text-left text-xs ${
                  focusPara === p.key ? "text-stone-900" : "text-stone-500"
                }`}
              >
                <span className="font-mono font-semibold">{p.key}</span>
                {score && <ScoreChip score={score.score} />}
                {score && <span className="truncate">{scoreLabel(score.score)}</span>}
              </button>
              {score && filter === "all" && <p className="text-xs leading-snug text-stone-600">{score.rationale}</p>}
              {shownComments.map((c) => (
                <div key={c.id} data-ann={c.id}>
                  <CommentCard a={c} />
                </div>
              ))}
              {shownProposals.map((pr) => (
                <div key={pr.id} data-ann={pr.annotation.id}>
                  <ProposalCard proposal={pr} compact />
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
