import { useMemo } from "react";
import { scoreColor } from "../docx/colors";
import { useEditorStore } from "../docx/editorStore";
import { useApp } from "../stores/app";

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} /> {label}
    </span>
  );
}

/**
 * Essay tab toolbar: the paragraph colour scale, the button that reveals annotation marks,
 * and the arrow that docks the review panel beside the essay.
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

  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-stone-500">
      <span>Detracts</span>
      <div className="h-2.5 w-36 rounded-full ring-1 ring-stone-200" style={{ background: gradient }} />
      <span>Advances thesis</span>
      {showDetails && (
        <>
          <span className="mx-1 h-3 w-px bg-stone-200" />
          <Swatch color="oklch(0.86 0.08 250)" label="comment" />
          <Swatch color="oklch(0.86 0.12 20)" label="grammar" />
          <Swatch color="oklch(0.86 0.1 300)" label="agent proposal" />
          <span className="text-stone-400">Click a mark for details</span>
        </>
      )}
      <div className="ml-auto flex items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={showScores} onChange={toggleScores} className="accent-stone-700" />
          Paragraph highlights
        </label>
        <button
          type="button"
          onClick={() => setShowDetails(!showDetails)}
          aria-pressed={showDetails}
          className={`rounded-md px-2.5 py-1 text-xs font-medium ${
            showDetails ? "bg-stone-800 text-white hover:bg-stone-700" : "text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50"
          }`}
        >
          {showDetails ? "Hide details" : `Show details${count ? ` (${count})` : ""}`}
        </button>
        <button
          type="button"
          onClick={() => setReviewOpen(!reviewOpen)}
          aria-expanded={reviewOpen}
          aria-label={reviewOpen ? "Hide review" : "Show review beside essay"}
          title={reviewOpen ? "Hide review" : "Show review beside essay"}
          className={`relative flex h-6 w-6 items-center justify-center rounded-md text-sm ${
            reviewOpen ? "bg-stone-800 text-white hover:bg-stone-700" : "text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50"
          }`}
        >
          {reviewOpen ? "▸" : "◂"}
          {!reviewOpen && pending > 0 && (
            <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-white" />
          )}
        </button>
      </div>
    </div>
  );
}
