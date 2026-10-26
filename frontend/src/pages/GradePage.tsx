import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Link, useParams } from "react-router";
import { api } from "../api/client";
import type { Paragraph } from "../api/gen/Paragraph";
import { AnnotationPanel } from "../components/annotations/AnnotationPanel";
import { AssessmentView } from "../components/assessment/AssessmentView";
import { ChatPane } from "../components/chat/ChatPane";
import { useEnsureModel } from "../components/ModelPicker";
import { RubricView } from "../components/RubricView";
import { ScoreLegend } from "../components/ScoreLegend";
import { DocxView, saveClean } from "../docx/DocxView";
import { useEditorStore } from "../docx/editorStore";
import { type Tab, useApp } from "../stores/app";
import { attachRun, startGrading } from "../stores/runs";

const TABS: { id: Tab; label: string }[] = [
  { id: "essay", label: "Essay" },
  { id: "rubric", label: "Rubric" },
  { id: "assessment", label: "Original Assessment" },
  { id: "review", label: "Review" },
];

const action = "rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 hover:text-stone-900 disabled:opacity-40";

function ExportButton({ name }: { name: string }) {
  const editor = useEditorStore((s) => s.editor);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={!editor || busy}
      onClick={async () => {
        if (!editor) return;
        setBusy(true);
        try {
          // Pending suggestions are previews, not essay text: leave them out.
          const buf = await saveClean(editor);
          const blob = new Blob([buf], {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `${name.replace(/\.docx$/i, "").replace(/[\\/:*?"<>|]+/g, " ").trim()} (reviewed).docx`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        } finally {
          setBusy(false);
        }
      }}
      className={action}
      title="Download the document with accepted edits applied"
    >
      Export
    </button>
  );
}

export function GradePage() {
  const { id } = useParams<{ id: string }>();
  const session = useApp((s) => s.session);
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const activeRunId = useApp((s) => s.activeRunId);
  const items = useApp((s) => s.items);
  const pendingCount = session?.proposals.filter((p) => p.status === "pending").length ?? 0;
  const reviewOpen = useEditorStore((s) => s.reviewOpen);
  const model = useEnsureModel();
  const [paragraphs, setParagraphs] = useState<Paragraph[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const autoStarted = useRef(false);

  useEffect(() => {
    if (!id) return;
    // A superseded load (essay switched, or StrictMode's double effect) must not land late
    // and overwrite state that grading has already started filling in.
    let alive = true;
    autoStarted.current = false;
    setParagraphs(null);
    useApp.getState().reset();
    api
      .getSession(id)
      .then((snap) => {
        if (!alive) return;
        useApp.getState().loadSession(snap);
        if (snap.active_run) attachRun(id, snap.active_run);
      })
      .catch((e) => alive && setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [id]);

  const onParagraphs = useCallback((ps: Paragraph[]) => setParagraphs(ps), []);

  const gradeAttempted = items.some((i) => i.kind === "assistant" && i.runKind === "grade");

  // Grade automatically once the document is open, the session is loaded and a model is chosen.
  useEffect(() => {
    if (!id || !session || !paragraphs || !model || autoStarted.current) return;
    if (session.graded || activeRunId || gradeAttempted) return;
    autoStarted.current = true;
    startGrading(id, paragraphs, model);
  }, [id, session, paragraphs, model, activeRunId, gradeAttempted]);

  if (loadError)
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-sm">
        <p className="text-red-600">{loadError}</p>
        <Link to="/" className="text-stone-700 underline">
          Back
        </Link>
      </div>
    );

  const canRetry = !!session && !session.graded && !activeRunId && gradeAttempted && !!paragraphs && !!model;
  const title = session?.essayName.replace(/\.docx$/i, "") ?? "";

  return (
    <div className="flex h-screen flex-col bg-white">
      <header className="grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-stone-200 px-3">
        <nav className="flex items-center gap-4 self-stretch">
          {TABS.map((t) => (
            <button
              type="button"
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px flex items-center gap-1 self-stretch border-b-2 text-[13px] ${
                tab === t.id
                  ? "border-stone-900 text-stone-900"
                  : "border-transparent text-stone-500 hover:text-stone-800"
              }`}
            >
              {t.label}
              {t.id === "review" && pendingCount > 0 && (
                <span className="text-[11px] tabular-nums text-amber-700">{pendingCount}</span>
              )}
            </button>
          ))}
        </nav>
        <h1 className="max-w-[40vw] truncate text-center text-[13px] font-medium text-stone-800" title={session?.essayName}>
          {title}
        </h1>
        <div className="flex items-center justify-end gap-1">
          {canRetry && (
            <button type="button" onClick={() => startGrading(id!, paragraphs!, model!)} className={`${action} text-amber-700`}>
              Retry grading
            </button>
          )}
          {session && <ExportButton name={session.essayName} />}
          <Link to="/" className={action}>
            New
          </Link>
          <Link to="/settings" className={action}>
            Settings
          </Link>
        </div>
      </header>

      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel defaultSize="64" minSize="35" className="flex min-h-0 flex-col">
          <div className="relative min-h-0 flex-1">
            {/* Kept mounted (just hidden) so the editor and its highlights survive tab switches. */}
            <div className={`absolute inset-0 flex flex-col ${tab === "essay" ? "" : "invisible"}`}>
              <div className="flex min-h-0 flex-1">
                <div className="min-w-0 flex-1">
                  {id && <DocxView sessionId={id} onParagraphs={onParagraphs} />}
                </div>
                {reviewOpen && (
                  <div className="w-[22rem] shrink-0">
                    <AnnotationPanel variant="docked" />
                  </div>
                )}
              </div>
              <div className="shrink-0 border-t border-stone-200 px-3 py-1">
                <ScoreLegend />
              </div>
            </div>
            {tab === "review" && (
              <div className="absolute inset-0">
                <AnnotationPanel />
              </div>
            )}
            {tab === "rubric" && (
              <div className="absolute inset-0">
                <RubricView />
              </div>
            )}
            {tab === "assessment" && (
              <div className="absolute inset-0">
                <AssessmentView />
              </div>
            )}
          </div>
        </Panel>
        <Separator className="w-px bg-stone-200 transition-colors hover:bg-stone-400 data-[separator=active]:bg-stone-500" />
        <Panel defaultSize="36" minSize="22" className="min-h-0">
          <ChatPane />
        </Panel>
      </Group>
    </div>
  );
}
