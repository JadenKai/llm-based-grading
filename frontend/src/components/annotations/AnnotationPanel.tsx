import { useEffect, useMemo, useRef, useState } from "react";
import type { Annotation } from "../../api/gen/Annotation";
import type { Proposal } from "../../api/gen/Proposal";
import { scoreLabel } from "../../docx/colors";
import { useEditorStore } from "../../docx/editorStore";
import { useApp } from "../../stores/app";
import { decideAll } from "../../stores/runs";
import { LocateButton, ProposalCard, ScoreChip } from "./ProposalCard";

type Filter = "all" | "pending" | "comments";
type Comment = Extract<Annotation, { kind: "comment" }>;
type Score = Extract<Annotation, { kind: "score" }>;

const AUTHOR_LABEL = { agent: "Grader", grammar: "Grammar", fact_check: "Fact-check" } as const;

export function CommentCard({ a, locate = true }: { a: Comment; locate?: boolean }) {
  const focused = useApp((s) => s.focusAnnotation === a.id);
  const tone =
    a.author === "fact_check" ? "border-l-orange-400" : a.author === "grammar" ? "border-l-rose-300" : "border-l-sky-400";
  return (
    <div
      className={`rounded-lg border border-l-4 bg-white p-2.5 shadow-sm ${tone} ${
        focused ? "border-amber-400 ring-2 ring-amber-200" : "border-stone-200"
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-stone-500">
        <span className="font-mono font-semibold text-stone-600">{a.para}</span>· {AUTHOR_LABEL[a.author]}
        {locate && (
          <>
            <span className="text-stone-300">·</span>
            <LocateButton para={a.para} annId={a.id} />
          </>
        )}
      </div>
      {a.anchor && (
        <blockquote className="mb-1 border-l-2 border-stone-200 pl-2 text-xs italic text-stone-500">“{a.anchor.quote}”</blockquote>
      )}
      <p className="text-sm text-stone-700">{a.text}</p>
    </div>
  );
}

/** The paragraph's score with its rationale. */
export function ScoreSummary({ a }: { a: Score }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs text-stone-600">
        <span className="font-mono font-semibold">{a.para}</span>
        <ScoreChip score={a.score} />
        <span>{scoreLabel(a.score)}</span>
      </div>
      <p className="text-xs leading-snug text-stone-600">{a.rationale}</p>
    </div>
  );
}

/**
 * Every comment, suggestion and paragraph score, grouped by paragraph. `tab` is the full-width
 * Review tab; `docked` is the narrow column shown beside the essay.
 */
export function AnnotationPanel({ variant = "tab" }: { variant?: "tab" | "docked" }) {
  const docked = variant === "docked";
  const session = useApp((s) => s.session);
  const setTab = useApp((s) => s.setTab);
  const setReviewOpen = useEditorStore((s) => s.setReviewOpen);
  const focusAnnotation = useApp((s) => s.focusAnnotation);
  const [filter, setFilter] = useState<Filter>("all");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    if (!session) return [];
    return session.paragraphs
      .map((p) => {
        const score = session.annotations.find((a): a is Score => a.kind === "score" && a.para === p.key);
        const comments = session.annotations.filter((a): a is Comment => a.kind === "comment" && a.para === p.key);
        const proposals = session.proposals.filter((x) => x.annotation.para === p.key);
        return { p, score, comments, proposals };
      })
      .filter((g) => g.score || g.comments.length || g.proposals.length);
  }, [session]);

  // Bring the focused item into view (e.g. after "Open in Review" from the essay).
  useEffect(() => {
    if (focusAnnotation) {
      listRef.current?.querySelector(`[data-ann="${focusAnnotation}"]`)?.scrollIntoView({ block: "center" });
    }
  }, [focusAnnotation]);

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
    <div className={`flex h-full flex-col bg-stone-50 ${docked ? "border-l border-stone-200" : ""}`}>
      <div className="border-b border-stone-200 bg-white">
        <div
          className={
            docked ? "flex flex-wrap items-center gap-2 px-3 py-2" : "mx-auto flex max-w-3xl flex-wrap items-center gap-3 px-6 py-3"
          }
        >
          {docked && (
            <div className="flex w-full items-center gap-2">
              <span className="text-sm font-semibold text-stone-800">Review</span>
              <span className="text-xs text-stone-500">{pending.length} awaiting</span>
              <button
                type="button"
                onClick={() => setTab("review")}
                className="ml-auto rounded px-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-900"
                title="Open in the Review tab"
              >
                ↗
              </button>
              <button
                type="button"
                onClick={() => setReviewOpen(false)}
                className="rounded px-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-900"
                title="Close"
              >
                ✕
              </button>
            </div>
          )}
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
          {!docked && <span className="text-xs text-stone-500">{pending.length} awaiting review</span>}
          {pendingGrammar.length > 0 && (
            <div className={`flex items-center gap-2 text-xs ${docked ? "w-full" : "ml-auto"}`}>
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
            <p className="w-full text-xs text-red-600">
              {bulkErrors.length} could not be applied (left pending). {bulkErrors[0]}
            </p>
          )}
        </div>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto">
        <div className={docked ? "space-y-5 px-3 py-4" : "mx-auto max-w-3xl space-y-6 px-6 py-5"}>
          {groups.length === 0 && <p className="text-sm text-stone-500">Comments and suggestions appear here as the essay is graded.</p>}
          {groups.map(({ p, score, comments, proposals }) => {
            const shownProposals = proposals.filter(visibleProposal);
            const shownComments = filter === "pending" ? [] : comments;
            if (filter !== "all" && !shownProposals.length && !shownComments.length) return null;
            return (
              <section key={p.key} className="space-y-2">
                <div className="flex items-center gap-2 border-b border-stone-200 pb-1 text-xs text-stone-500">
                  <span className="font-mono font-semibold text-stone-700">{p.key}</span>
                  {score && <ScoreChip score={score.score} />}
                  {score && <span className="truncate">{scoreLabel(score.score)}</span>}
                  <span className="ml-auto">
                    <LocateButton para={p.key} annId={score?.id ?? null} />
                  </span>
                </div>
                {score && filter === "all" && (
                  <p data-ann={score.id} className="text-sm leading-snug text-stone-600">
                    {score.rationale}
                  </p>
                )}
                <div className={docked ? "space-y-2" : "grid gap-2 sm:grid-cols-2"}>
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
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
