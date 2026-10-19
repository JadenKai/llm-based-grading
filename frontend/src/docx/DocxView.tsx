import { DocxEditor, type Editor } from "@docx-editor.dev/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Paragraph } from "../api/gen/Paragraph";
import { useApp } from "../stores/app";
import { annotationsAt, extractParagraphs, scrollTo, syncHighlights } from "./bridge";
import { useEditorStore } from "./editorStore";

const AUTHOR = "Essay Grader";

async function waitForParagraphs(editor: Editor, timeoutMs = 8000) {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try {
      if (editor.query({ type: "paragraphs" }).some((p) => p.text.trim())) return;
    } catch {
      /* not open yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sameTexts = (a: Paragraph[], b: Paragraph[]) =>
  a.length === b.length && a.every((p, i) => p.key === b[i].key && p.text === b[i].text);

export function DocxView({
  sessionId,
  title,
  onParagraphs,
}: {
  sessionId: string;
  title?: string;
  /** Called once the document is open, with its paragraphs. */
  onParagraphs: (paragraphs: Paragraph[]) => void;
}) {
  const [doc, setDoc] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editor = useEditorStore((s) => s.editor);
  const blocks = useEditorStore((s) => s.blocks);
  const showScores = useEditorStore((s) => s.showScores);
  const annotations = useApp((s) => s.session?.annotations);
  const proposals = useApp((s) => s.session?.proposals);
  const focusAnnotation = useApp((s) => s.focusAnnotation);
  const focusPara = useApp((s) => s.focusPara);
  const onParagraphsRef = useRef(onParagraphs);
  onParagraphsRef.current = onParagraphs;
  const syncTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setDoc(null);
    api
      .docx(sessionId)
      .then((d) => alive && setDoc(d))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
      useEditorStore.getState().setEditor(null);
      useEditorStore.getState().setBlocks(new Map());
    };
  }, [sessionId]);

  const onReady = useCallback(async (ed: Editor) => {
    await waitForParagraphs(ed);
    const { paragraphs, blocks } = extractParagraphs(ed);
    useEditorStore.getState().setBlocks(blocks);
    useEditorStore.getState().setEditor(ed);
    onParagraphsRef.current(paragraphs);
  }, []);

  // After any document change: store the edited .docx (so accepted edits survive a reload)
  // and keep the backend's paragraph text in sync with edits the teacher typed.
  const onChange = useCallback(() => {
    window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(async () => {
      const ed = useEditorStore.getState().editor;
      const session = useApp.getState().session;
      if (!ed || !session) return;
      const { paragraphs, blocks } = extractParagraphs(ed);
      useEditorStore.getState().setBlocks(blocks);
      try {
        await api.putDocx(session.id, await ed.save());
      } catch (e) {
        console.warn("saving the document failed", e);
      }
      if (!session.paragraphs.length || sameTexts(paragraphs, session.paragraphs)) return;
      try {
        const snap = await api.putParagraphs(session.id, paragraphs);
        useApp.getState().applyDecision({
          proposals: snap.proposals,
          annotations: snap.annotations,
          paragraphs: snap.paragraphs,
        });
      } catch (e) {
        console.warn("paragraph sync failed", e);
      }
    }, 700);
  }, []);

  useEffect(() => {
    if (!editor) return;
    syncHighlights(editor, blocks, {
      annotations: annotations ?? [],
      proposals: proposals ?? [],
      showScores,
      focusAnnotation,
    });
  }, [editor, blocks, annotations, proposals, showScores, focusAnnotation]);

  useEffect(() => {
    if (editor && focusPara) scrollTo(editor, blocks.get(focusPara));
  }, [editor, blocks, focusPara]);

  const onClickCapture = (e: React.MouseEvent) => {
    if (!editor) return;
    const hits = annotationsAt(editor, e.clientX, e.clientY);
    const s = useApp.getState().session;
    const kindOf = (id?: string) =>
      (s?.annotations.find((a) => a.id === id) ?? s?.proposals.find((p) => p.annotation.id === id)?.annotation)?.kind;
    // Prefer a specific annotation (comment / edit) over the paragraph score underneath.
    const specific = hits.find((h) => h.annId && kindOf(h.annId) !== "score");
    const hit = specific ?? hits[0];
    if (hit) useApp.setState({ focusPara: hit.para, focusAnnotation: hit.annId ?? null });
  };

  if (error) return <div className="p-6 text-sm text-red-600">Could not load the document: {error}</div>;
  if (!doc) return <div className="p-6 text-sm text-stone-500">Loading document…</div>;
  return (
    <div className="h-full min-h-0" onClickCapture={onClickCapture}>
      <DocxEditor
        className="h-full"
        document={doc}
        author={AUTHOR}
        title={title}
        onReady={onReady}
        onChange={onChange}
        rulers={false}
      />
    </div>
  );
}
