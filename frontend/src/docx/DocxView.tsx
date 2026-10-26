import { DocxEditor, type Editor } from "@docx-editor.dev/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Paragraph } from "../api/gen/Paragraph";
import { DetailsPopover, type PopoverState } from "../components/annotations/DetailsPopover";
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
  const showDetails = useEditorStore((s) => s.showDetails);
  const annotations = useApp((s) => s.session?.annotations);
  const proposals = useApp((s) => s.session?.proposals);
  const focusAnnotation = useApp((s) => s.focusAnnotation);
  const focusPara = useApp((s) => s.focusPara);
  const tab = useApp((s) => s.tab);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
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
      showDetails,
      focusAnnotation,
    });
  }, [editor, blocks, annotations, proposals, showScores, showDetails, focusAnnotation]);

  useEffect(() => {
    if (editor && focusPara) scrollTo(editor, blocks.get(focusPara));
  }, [editor, blocks, focusPara]);

  const popoverRef = useRef(popover);
  popoverRef.current = popover;
  const closePopover = useCallback(() => {
    const p = popoverRef.current;
    if (!p) return;
    if (useApp.getState().focusAnnotation === p.annIds[0]) useApp.setState({ focusAnnotation: null });
    setPopover(null);
  }, []);
  // Hiding details or leaving the Essay tab closes the popover.
  useEffect(() => {
    if (!showDetails || tab !== "essay") closePopover();
  }, [showDetails, tab, closePopover]);

  // With details shown, clicking a marked passage opens its details.
  const onClickCapture = (e: React.MouseEvent) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!editor || !box) return;
    const hits = showDetails ? annotationsAt(editor, e.clientX, e.clientY) : [];
    if (!hits.length) {
      // A click elsewhere dismisses the popover and any "Show in essay" mark.
      closePopover();
      if (useApp.getState().focusAnnotation) useApp.setState({ focusAnnotation: null });
      return;
    }
    const s = useApp.getState().session;
    const kindOf = (id?: string) =>
      (s?.annotations.find((a) => a.id === id) ?? s?.proposals.find((p) => p.annotation.id === id)?.annotation)?.kind;
    // Specific marks (comments, edits) first, the paragraph's score last.
    const ordered = [...hits.filter((h) => kindOf(h.annId) !== "score"), ...hits.filter((h) => kindOf(h.annId) === "score")];
    const annIds = [...new Set(ordered.flatMap((h) => (h.annId ? [h.annId] : [])))];
    const anchor = ordered[0].rect;
    const below = anchor.bottom - box.top + 6;
    const above = below + 340 > box.height && anchor.top - box.top > 340;
    setPopover({
      annIds,
      para: ordered[0].para,
      left: Math.max(8, Math.min(anchor.left - box.left, box.width - 330)),
      top: above ? anchor.top - box.top - 6 : below,
      above,
    });
    useApp.setState({ focusAnnotation: annIds[0] ?? null });
  };

  if (error) return <div className="p-6 text-sm text-red-600">Could not load the document: {error}</div>;
  if (!doc) return <div className="p-6 text-sm text-stone-500">Loading document…</div>;
  return (
    <div ref={wrapRef} className="relative h-full min-h-0">
      <div className="h-full" onClickCapture={onClickCapture} onWheelCapture={() => popover && closePopover()}>
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
      {popover && <DetailsPopover state={popover} onClose={closePopover} />}
    </div>
  );
}
