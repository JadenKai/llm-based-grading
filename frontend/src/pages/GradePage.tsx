import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import type { Paragraph } from "../api/gen/Paragraph";
import { AnnotationPanel } from "../components/annotations/AnnotationPanel";
import { AssessmentView } from "../components/assessment/AssessmentView";
import { ChatPane } from "../components/chat/ChatPane";
import { Pane, Workspace } from "../components/layout/Workspace";
import { useEnsureModel } from "../components/ModelPicker";
import { RubricView } from "../components/RubricView";
import { ScoreLegend } from "../components/ScoreLegend";
import { DocxView, saveClean } from "../docx/DocxView";
import { useEditorStore } from "../docx/editorStore";
import { useApp } from "../stores/app";
import { attachRun, startGrading } from "../stores/runs";

async function exportDocx(name: string) {
  const editor = useEditorStore.getState().editor;
  if (!editor) return;
  // Pending suggestions are previews, not essay text: leave them out.
  const buf = await saveClean(editor);
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/\.docx$/i, "").replace(/[\\/:*?"<>|]+/g, " ").trim()} (reviewed).docx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function GradePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const session = useApp((s) => s.session);
  const tab = useApp((s) => s.tab);
  const setTab = useApp((s) => s.setTab);
  const rightTab = useApp((s) => s.rightTab);
  const setRightTab = useApp((s) => s.setRightTab);
  const activeRunId = useApp((s) => s.activeRunId);
  const items = useApp((s) => s.items);
  const pendingCount = session?.proposals.filter((p) => p.status === "pending").length ?? 0;
  const reviewOpen = useEditorStore((s) => s.reviewOpen);
  const editorReady = useEditorStore((s) => !!s.editor);
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
          Start over
        </Link>
      </div>
    );

  const canRetry = !!session && !session.graded && !activeRunId && gradeAttempted && !!paragraphs && !!model;

  return (
    <Workspace
      title={<span title={session?.essayName}>{session?.essayName.replace(/\.docx$/i, "") ?? ""}</span>}
      leftTabs={[
        { id: "essay", label: "Essay" },
        { id: "review", label: "Review", badge: pendingCount },
      ]}
      leftTab={tab}
      onLeftTab={setTab}
      rightTabs={[
        { id: "chat", label: "Chat" },
        { id: "rubric", label: "Rubric" },
        { id: "assessment", label: "Original Assessment" },
      ]}
      rightTab={rightTab}
      onRightTab={setRightTab}
      menu={[
        ...(canRetry ? [{ label: "Retry grading", onSelect: () => startGrading(id!, paragraphs!, model!) }] : []),
        { label: "Export .docx", disabled: !session || !editorReady, onSelect: () => session && exportDocx(session.essayName) },
        { label: "New essay", onSelect: () => navigate("/") },
        { label: "Settings", to: "/settings" },
      ]}
      left={
        <>
          {/* Kept mounted (just hidden) so the editor and its highlights survive tab switches. */}
          <Pane shown={tab === "essay"}>
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1">{id && <DocxView sessionId={id} onParagraphs={onParagraphs} />}</div>
              {reviewOpen && (
                <div className="w-[22rem] shrink-0">
                  <AnnotationPanel variant="docked" />
                </div>
              )}
            </div>
            <div className="shrink-0 border-t border-stone-200 px-3 py-1">
              <ScoreLegend />
            </div>
          </Pane>
          {tab === "review" && (
            <div className="absolute inset-0">
              <AnnotationPanel />
            </div>
          )}
        </>
      }
      right={
        <>
          <Pane shown={rightTab === "chat"}>
            <ChatPane />
          </Pane>
          {rightTab === "rubric" && (
            <div className="absolute inset-0">
              <RubricView />
            </div>
          )}
          {rightTab === "assessment" && (
            <div className="absolute inset-0">
              <AssessmentView />
            </div>
          )}
        </>
      }
    />
  );
}
