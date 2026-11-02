import { useEffect, useState } from "react";
import type { Annotation } from "../../api/gen/Annotation";
import type { Proposal } from "../../api/gen/Proposal";
import { useEditorStore } from "../../docx/editorStore";
import { useApp } from "../../stores/app";
import { CommentCard, ScoreSummary } from "./AnnotationPanel";
import { AddCommentLink } from "./InstructorComments";
import { ProposalCard } from "./ProposalCard";

export interface PopoverState {
  /** Paragraph whose details are shown. */
  para: string;
  /** The specific comment or fix that was clicked; its tab opens first. */
  focusId: string | null;
  left: number;
  top: number;
  /** Open above the anchor instead of below it. */
  above: boolean;
}

type Comment = Extract<Annotation, { kind: "comment" }>;
type Category = "grader" | "facts" | "grammar" | "instructor";
type Item = { kind: "comment"; c: Comment } | { kind: "proposal"; p: Proposal };

const TABS: { id: Category; label: string }[] = [
  { id: "grader", label: "Grader" },
  { id: "facts", label: "Fact-checks" },
  { id: "grammar", label: "Spelling & grammar" },
  { id: "instructor", label: "Instructor" },
];

function categoryOf(a: Annotation): Category {
  if (a.kind === "comment") {
    if (a.author === "instructor") return "instructor";
    if (a.author === "fact_check") return "facts";
    if (a.author === "grammar") return "grammar";
    return "grader";
  }
  if (a.kind === "edit" && a.source === "harper") return "grammar";
  return "grader";
}

/** The clicked paragraph: its score, then its comments and suggestions by kind. */
export function DetailsPopover({ state, onClose }: { state: PopoverState; onClose: () => void }) {
  const session = useApp((s) => s.session);
  const setTab = useApp((s) => s.setTab);
  const focus = useApp((s) => s.focus);

  const items: Item[] = session
    ? [
        ...session.annotations
          .filter((a): a is Comment => a.kind === "comment" && a.para === state.para)
          .map((c): Item => ({ kind: "comment", c })),
        ...session.proposals
          .filter((p) => p.status === "pending" && p.annotation.para === state.para)
          .map((p): Item => ({ kind: "proposal", p })),
      ]
    : [];
  const ann = (it: Item) => (it.kind === "comment" ? it.c : it.p.annotation);
  const byTab = (t: Category) => items.filter((it) => categoryOf(ann(it)) === t);
  const focused = items.find((it) => ann(it).id === state.focusId);
  const initial: Category = focused
    ? categoryOf(ann(focused))
    : (TABS.find((t) => byTab(t.id).length)?.id ?? "grader");
  const [tab, setTabState] = useState<Category>(initial);
  // Reopen on the right tab when another paragraph or item is clicked.
  useEffect(() => setTabState(initial), [state.para, state.focusId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!session) return null;
  const score = session.annotations.find(
    (a): a is Extract<Annotation, { kind: "score" }> => a.kind === "score" && a.para === state.para,
  );
  const shown = byTab(tab).sort((a, b) => Number(ann(b).id === state.focusId) - Number(ann(a).id === state.focusId));

  return (
    <div
      className="absolute z-30 w-[26rem] rounded-lg border border-stone-200 bg-white shadow-lg"
      style={{ left: state.left, top: state.top, transform: state.above ? "translateY(-100%)" : undefined }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="space-y-2 border-b border-stone-100 px-3 pt-2.5 pb-2">
        <div className="flex items-center justify-between">
          {score ? <ScoreSummary a={score} /> : <span className="text-xs font-medium text-stone-500">{state.para}</span>}
          <button type="button" onClick={onClose} className="self-start text-xs text-stone-400 hover:text-stone-800" aria-label="Close">
            Close
          </button>
        </div>
        <div role="tablist" className="flex gap-3 text-xs">
          {TABS.map((t) => {
            const n = byTab(t.id).length;
            return (
              <button
                type="button"
                role="tab"
                key={t.id}
                aria-selected={tab === t.id}
                onClick={() => setTabState(t.id)}
                className={`-mb-2 border-b-2 pb-1.5 whitespace-nowrap ${t.id === "instructor" ? "ml-auto" : ""} ${
                  tab === t.id ? "border-stone-900 text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800"
                }`}
              >
                {t.label}
                {n > 0 && <span className="ml-1 tabular-nums text-stone-400">{n}</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="max-h-72 space-y-2 overflow-y-auto p-3">
        {shown.map((it) =>
          it.kind === "comment" ? (
            <CommentCard key={it.c.id} a={it.c} locate={false} />
          ) : (
            <ProposalCard key={it.p.id} proposal={it.p} locate={false} />
          ),
        )}
        {!shown.length && tab !== "instructor" && <p className="text-xs text-stone-400">Nothing here.</p>}
        {tab === "instructor" && <AddCommentLink key={state.para} para={state.para} />}
      </div>
      <div className="border-t border-stone-100 px-3 py-2">
        <button
          type="button"
          onClick={() => {
            // Close first: closing clears the popover's focus mark, which focus() then sets again.
            onClose();
            // With the review docked beside the essay, just bring the item into view there.
            if (!useEditorStore.getState().reviewOpen) setTab("review");
            focus(state.para, state.focusId ?? score?.id ?? null);
          }}
          className="text-xs text-stone-500 hover:text-stone-900"
        >
          Open in Review →
        </button>
      </div>
    </div>
  );
}
