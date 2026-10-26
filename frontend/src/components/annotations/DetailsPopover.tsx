import { useEffect } from "react";
import type { Annotation } from "../../api/gen/Annotation";
import type { Proposal } from "../../api/gen/Proposal";
import { useEditorStore } from "../../docx/editorStore";
import { useApp } from "../../stores/app";
import { CommentCard, ScoreSummary } from "./AnnotationPanel";
import { ProposalCard } from "./ProposalCard";

export interface PopoverState {
  /** Annotation ids under the click, most specific first. */
  annIds: string[];
  para: string;
  left: number;
  top: number;
  /** Open above the anchor instead of below it. */
  above: boolean;
}

type Item = { kind: "annotation"; a: Annotation } | { kind: "proposal"; p: Proposal };

/** Details for the passage the teacher clicked on the essay. */
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
  const items: Item[] = state.annIds.flatMap((id): Item[] => {
    const p = session.proposals.find((x) => x.annotation.id === id);
    if (p) return [{ kind: "proposal", p }];
    const a = session.annotations.find((x) => x.id === id);
    return a ? [{ kind: "annotation", a }] : [];
  });
  if (!items.length) return null;

  return (
    <div
      className="absolute z-30 w-80 space-y-2 rounded-xl border border-stone-200 bg-white p-3 shadow-xl"
      style={{ left: state.left, top: state.top, transform: state.above ? "translateY(-100%)" : undefined }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">Details · {state.para}</span>
        <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-700" title="Close (Esc)">
          ✕
        </button>
      </div>
      <div className="max-h-80 space-y-2 overflow-y-auto">
        {items.map((it) =>
          it.kind === "proposal" ? (
            <ProposalCard key={it.p.id} proposal={it.p} locate={false} />
          ) : it.a.kind === "comment" ? (
            <CommentCard key={it.a.id} a={it.a} locate={false} />
          ) : it.a.kind === "score" ? (
            <ScoreSummary key={it.a.id} a={it.a} />
          ) : null,
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          // Close first: closing clears the popover's focus mark, which focus() then sets again.
          onClose();
          // With the review docked beside the essay, just bring the item into view there.
          if (!useEditorStore.getState().reviewOpen) setTab("review");
          focus(state.para, state.annIds[0] ?? null);
        }}
        className="text-xs text-blue-700 hover:underline"
      >
        Open in Review →
      </button>
    </div>
  );
}
