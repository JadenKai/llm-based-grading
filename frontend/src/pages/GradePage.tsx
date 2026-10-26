import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Link, useParams } from "react-router";
import { api } from "../api/client";
import type { Paragraph } from "../api/gen/Paragraph";
import { AnnotationPanel } from "../components/annotations/AnnotationPanel";
import { AssessmentView } from "../components/assessment/AssessmentView";
import { ChatPane } from "../components/chat/ChatPane";
import { Markdown } from "../components/Markdown";
import { useEnsureModel } from "../components/ModelPicker";
import { ScoreLegend } from "../components/ScoreLegend";
import { DocxView } from "../docx/DocxView";
import { useEditorStore } from "../docx/editorStore";
import { type Tab, useApp } from "../stores/app";
import { attachRun, startGrading } from "../stores/runs";

const TABS: { id: Tab; label: string }[] = [
  { id: "essay", label: "Essay" },
  { id: "rubric", label: "Rubric" },
  { id: "assessment", label: "Original Assessment" },
  { id: "review", label: "Review" },
];

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
          const buf = await editor.save();
          const blob = new Blob([buf], {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = name.replace(/\.docx$/i, "") + " (reviewed).docx";
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        } finally {
          setBusy(false);
        }
      }}
      className="rounded-md px-2.5 py-1 text-sm text-stone-600 ring-1 ring-stone-300 hover:bg-stone-50 disabled:opacity-50"
      title="Download the document with accepted edits applied"
    >
      Export .docx
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
        <Link to="/" className="text-blue-700 underline">
          Back to upload
        </Link>
      </div>
    );

  const canRetry = !!session && !session.graded && !activeRunId && gradeAttempted && !!paragraphs && !!model;

  return (
    <div className="flex h-screen flex-col bg-stone-100">
      <header className="flex items-center gap-3 border-b border-stone-200 bg-white px-4 py-2">
        <Link to="/" className="text-sm font-semibold text-stone-800">
          ✎ Essay Grader
        </Link>
        <span className="text-stone-300">/</span>
        <span className="truncate text-sm text-stone-600">{session?.essayName ?? "…"}</span>
        {session?.assessment && (
          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700">
            {session.assessment.overall} / {session.assessment.max}
          </span>
        )}
        {canRetry && (
          <button
            type="button"
            onClick={() => startGrading(id!, paragraphs!, model!)}
            className="rounded-md bg-amber-500 px-2.5 py-1 text-sm font-medium text-white hover:bg-amber-600"
          >
            Retry grading
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {session && <ExportButton name={session.essayName} />}
          <Link to="/" className="rounded-md px-2.5 py-1 text-sm text-stone-600 hover:bg-stone-100">
            New essay
          </Link>
          <Link to="/settings" className="rounded-md px-2.5 py-1 text-sm text-stone-600 hover:bg-stone-100" title="Settings">
            ⚙ Settings
          </Link>
        </div>
      </header>

      <Group orientation="horizontal" className="min-h-0 flex-1">
        <Panel defaultSize="64" minSize="35" className="flex min-h-0 flex-col bg-white">
          <nav className="flex items-end gap-1 border-b border-stone-200 bg-stone-50 px-3 pt-2">
            {TABS.map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-t-lg px-3.5 py-1.5 text-sm ${
                  tab === t.id
                    ? "border border-b-white border-stone-200 bg-white font-medium text-stone-900 -mb-px"
                    : "text-stone-500 hover:text-stone-800"
                }`}
              >
                {t.label}
                {t.id === "review" && pendingCount > 0 && (
                  <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-px text-[11px] font-medium text-amber-800">
                    {pendingCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
          <div className="relative min-h-0 flex-1">
            {/* Kept mounted (just hidden) so the editor and its highlights survive tab switches. */}
            <div className={`absolute inset-0 flex flex-col ${tab === "essay" ? "" : "invisible"}`}>
              <div className="border-b border-stone-100 px-3 py-1.5">
                <ScoreLegend />
              </div>
              <div className="flex min-h-0 flex-1">
                <div className="min-w-0 flex-1">
                  {id && <DocxView sessionId={id} title={session?.essayName} onParagraphs={onParagraphs} />}
                </div>
                {reviewOpen && (
                  <div className="w-[22rem] shrink-0">
                    <AnnotationPanel variant="docked" />
                  </div>
                )}
              </div>
            </div>
            {tab === "review" && (
              <div className="absolute inset-0">
                <AnnotationPanel />
              </div>
            )}
            {tab === "rubric" && (
              <div className="absolute inset-0 overflow-y-auto">
                <div className="mx-auto max-w-3xl p-6">
                  <p className="mb-3 text-xs text-stone-400">{session?.rubricName}</p>
                  <Markdown className="text-sm text-stone-800">{session?.rubricMd ?? ""}</Markdown>
                </div>
              </div>
            )}
            {tab === "assessment" && (
              <div className="absolute inset-0">
                <AssessmentView />
              </div>
            )}
          </div>
        </Panel>
        <Separator className="w-1.5 bg-stone-200 transition-colors hover:bg-stone-300 data-[separator=active]:bg-stone-400" />
        <Panel defaultSize="36" minSize="22" className="min-h-0">
          <ChatPane />
        </Panel>
      </Group>
    </div>
  );
}
