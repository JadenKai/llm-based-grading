import { scoreColor } from "../docx/colors";
import { useEditorStore } from "../docx/editorStore";

export function ScoreLegend() {
  const showScores = useEditorStore((s) => s.showScores);
  const toggle = useEditorStore((s) => s.toggleScores);
  const gradient = `linear-gradient(to right, ${Array.from({ length: 11 }, (_, b) => scoreColor(b)).join(", ")})`;
  return (
    <div className="flex items-center gap-3 text-[11px] text-stone-500">
      <span>Detracts</span>
      <div className="h-2.5 w-36 rounded-full ring-1 ring-stone-200" style={{ background: gradient }} />
      <span>Advances thesis</span>
      <span className="mx-1 h-3 w-px bg-stone-200" />
      <span className="inline-flex items-center gap-1">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "oklch(0.86 0.08 250)" }} /> comment
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "oklch(0.86 0.12 20)" }} /> grammar
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: "oklch(0.86 0.1 300)" }} /> pending proposal
      </span>
      <label className="ml-auto inline-flex cursor-pointer items-center gap-1.5">
        <input type="checkbox" checked={showScores} onChange={toggle} className="accent-stone-700" />
        Paragraph highlights
      </label>
    </div>
  );
}
