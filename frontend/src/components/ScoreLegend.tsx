import { useMemo } from "react";
import { scoreColor } from "../docx/colors";
import { useEditorStore } from "../docx/editorStore";
import { useApp } from "../stores/app";

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} /> {label}
    </span>
  );
}

/**
 * Essay status bar: a small colour key for the paragraph scores, the toggle that reveals
 * annotation marks, and the arrow that docks the review panel beside the essay.
 */
export function ScoreLegend() {
  const showScores = useEditorStore((s) => s.showScores);
  const toggleScores = useEditorStore((s) => s.toggleScores);
  const showDetails = useEditorStore((s) => s.showDetails);
  const setShowDetails = useEditorStore((s) => s.setShowDetails);
  const reviewOpen = useEditorStore((s) => s.reviewOpen);
  const setReviewOpen = useEditorStore((s) => s.setReviewOpen);
  const annotations = useApp((s) => s.session?.annotations);
  const proposals = useApp((s) => s.session?.proposals);
  const pending = useMemo(() => (proposals ?? []).filter((p) => p.status === "pending").length, [proposals]);
  const count = useMemo(
    () => (annotations ?? []).filter((a) => a.kind === "comment").length + pending,
    [annotations, pending],
  );
  const gradient = `linear-gradient(to right, ${Array.from({ length: 11 }, (_, b) => scoreColor(b)).join(", ")})`;
  const btn = "rounded px-1.5 py-0.5 hover:bg-stone-100 hover:text-stone-900";

  return (
    <div className="flex h-6 items-center gap-2 text-[11px] text-stone-500">
      <span>Detracts</span>
      <div className="h-1.5 w-20 rounded-full" style={{ background: gradient }} aria-hidden />
      <span>Advances thesis</span>
      {showDetails && (
        <>
          <span className="mx-1 h-3 w-px bg-stone-200" />
          <Swatch color="oklch(0.86 0.08 250)" label="comment" />
          <Swatch color="oklch(0.62 0.2 25)" label="suggested fix" />
          <Swatch color="oklch(0.86 0.1 300)" label="agent proposal" />
        </>
      )}
      <div className="ml-auto flex items-center gap-1">
        <label className={`${btn} inline-flex cursor-pointer items-center gap-1`}>
          <input type="checkbox" checked={showScores} onChange={toggleScores} className="h-3 w-3 accent-stone-700" />
          Highlights
        </label>
        <button
          type="button"
          onClick={() => setShowDetails(!showDetails)}
          aria-pressed={showDetails}
          className={`${btn} ${showDetails ? "text-stone-900" : ""}`}
        >
          {showDetails ? "Hide details" : `Show details${count ? ` (${count})` : ""}`}
        </button>
        <button
          type="button"
          onClick={() => setReviewOpen(!reviewOpen)}
          aria-expanded={reviewOpen}
          aria-label={reviewOpen ? "Hide review" : "Show review beside essay"}
          title={reviewOpen ? "Hide review" : "Show review beside essay"}
          className={`${btn} relative ${reviewOpen ? "text-stone-900" : ""}`}
        >
          {reviewOpen ? "Review ▸" : "◂ Review"}
          {!reviewOpen && pending > 0 && <span className="absolute top-0 right-0 h-1.5 w-1.5 rounded-full bg-amber-500" />}
        </button>
      </div>
    </div>
  );
}
