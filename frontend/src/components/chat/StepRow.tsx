import { useState } from "react";
import { useApp } from "../../stores/app";
import type { StepNode, ToolCallView } from "../../stores/applyEvent";


function StatusDot({ status }: { status: StepNode["status"] }) {
  if (status === "running")
    return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-stone-300 border-t-stone-600" />;
  const map = { ok: "text-emerald-600", error: "text-red-500", skipped: "text-stone-400", cancelled: "text-stone-400" };
  const glyph = { ok: "✓", error: "✕", skipped: "–", cancelled: "■" };
  return <span className={`w-3 text-center text-xs font-bold ${map[status]}`}>{glyph[status]}</span>;
}

function ThinkingBlock({ text, running }: { text: string; running: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ml-5 mt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-stone-400 hover:text-stone-700"
      >
        {open ? "▾" : "▸"} {running ? "Thinking…" : "Reasoning"}
      </button>
      {open && (
        <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md bg-stone-50 p-2 font-sans text-xs leading-relaxed text-stone-600">
          {text}
        </pre>
      )}
    </div>
  );
}

function ToolCallDetail({ tc }: { tc: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const links =
    Array.isArray(tc.result?.data) &&
    (tc.result!.data as unknown[]).filter((x): x is { title: string; url: string } => !!x && typeof x === "object" && "url" in x);
  return (
    <div className="ml-5 mt-1 text-[11px]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-stone-500 hover:text-stone-800">
        {open ? "▾" : "▸"} <span className="font-mono">{tc.name}</span>
        {tc.result && <span className={tc.result.ok ? "text-stone-500" : "text-red-500"}> → {tc.result.summary}</span>}
      </button>
      {links && links.length > 0 && (
        <ul className="ml-3 mt-0.5 space-y-0.5">
          {links.slice(0, 5).map((l) => (
            <li key={l.url} className="truncate">
              <a href={l.url} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">
                {l.title || l.url}
              </a>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-stone-100 p-2 font-mono text-[10px] text-stone-700">
          {JSON.stringify(tc.arguments, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function StepRow({ id, depth = 0 }: { id: string; depth?: number }) {
  const step = useApp((s) => s.steps[id]);
  const [expanded, setExpanded] = useState(true);
  if (!step) return null;
  const hasChildren = step.children.length > 0;
  return (
    <div className={depth ? "ml-4" : ""}>
      <div className="flex items-start gap-2 py-0.5 text-[13px]">
        <span className="mt-0.5 flex w-3 justify-center">
          <StatusDot status={step.status} />
        </span>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className={`text-left ${step.status === "running" ? "text-stone-900" : "text-stone-600"} ${
              hasChildren ? "hover:text-stone-900" : "cursor-default"
            }`}
            onClick={() => hasChildren && setExpanded((e) => !e)}
          >
            {step.label}
            {hasChildren && <span className="ml-1 text-stone-400">{expanded ? "▾" : "▸"}</span>}
          </button>
          {step.summary && (
            <span className={`ml-2 text-xs ${step.status === "error" ? "text-red-500" : "text-stone-400"}`}>
              {step.summary}
            </span>
          )}
          {step.detail && step.status === "running" && <div className="text-xs text-amber-600">{step.detail}</div>}
        </div>
      </div>
      {step.thinking && <ThinkingBlock text={step.thinking} running={step.status === "running"} />}
      {step.toolCalls.map((tc) => (
        <ToolCallDetail key={tc.callId} tc={tc} />
      ))}
      {hasChildren && expanded && (
        <div className="border-l border-stone-200 pl-1">
          {step.children.map((c) => (
            <StepRow key={c} id={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
