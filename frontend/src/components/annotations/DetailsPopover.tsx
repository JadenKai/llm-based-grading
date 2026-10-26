import { useEffect } from "react";
import type { Annotation } from "../../api/gen/Annotation";
import { useEditorStore } from "../../docx/editorStore";
import { useApp } from "../../stores/app";
import { CommentCard, ScoreSummary } from "./AnnotationPanel";
import { ProposalCard } from "./ProposalCard";

export interface PopoverState {
  /** Paragraph whose details are shown. */
  para: string;
  /** The specific comment or fix that was clicked, listed first. */
  focusId: string | null;
  left: number;
  top: number;
  /** Open above the anchor instead of below it. */
  above: boolean;
}

/** Everything about the clicked paragraph: its score, comments and suggestions. */
export function DetailsPopover({ state, onClose }: { state: PopoverState; onClose: () => void }) {
  const session = useApp((s) => s.session);
  const setTab = useApp((s) => s.setTab);
  const focus = useApp((s) => s.focus);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!session) return null;
  const score = session.annotations.find(
    (a): a is Extract<Annotation, { kind: "score" }> => a.kind === "score" && a.para === state.para,
  );
  const first = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => Number(b.id === state.focusId) - Number(a.id === state.focusId));
  const comments = first(
    session.annotations.filter((a): a is Extract<Annotation, { kind: "comment" }> => a.kind === "comment" && a.para === state.para),
  );
  const proposals = session.proposals
    .filter((p) => p.status === "pending" && p.annotation.para === state.para)
    .sort((a, b) => Number(b.annotation.id === state.focusId) - Number(a.annotation.id === state.focusId));
  const focusedIsProposal = proposals.some((p) => p.annotation.id === state.focusId);

  return (
    <div
      className="absolute z-30 w-80 rounded-lg border border-stone-200 bg-white shadow-lg"
      style={{ left: state.left, top: state.top, transform: state.above ? "translateY(-100%)" : undefined }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-stone-100 px-3 py-2">
        <span className="text-xs font-medium text-stone-500">{state.para}</span>
        <button type="button" onClick={onClose} className="text-xs text-stone-400 hover:text-stone-800" aria-label="Close">
          Close
        </button>
      </div>
      <div className="max-h-80 space-y-2 overflow-y-auto p-3">
        {score && <ScoreSummary a={score} />}
        {focusedIsProposal && proposals.map((p) => <ProposalCard key={p.id} proposal={p} locate={false} />)}
        {comments.map((c) => (
          <CommentCard key={c.id} a={c} locate={false} />
        ))}
        {!focusedIsProposal && proposals.map((p) => <ProposalCard key={p.id} proposal={p} locate={false} />)}
        {!score && !comments.length && !proposals.length && <p className="text-xs text-stone-400">Nothing here yet.</p>}
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
