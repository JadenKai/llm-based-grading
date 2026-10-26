import { DocxEditor, type Editor } from "@docx-editor.dev/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { Paragraph } from "../api/gen/Paragraph";
import type { Proposal } from "../api/gen/Proposal";
import { DetailsPopover, type PopoverState } from "../components/annotations/DetailsPopover";
import { useApp } from "../stores/app";
import { annotationsAt, extractParagraphs, type BlockRef, type Hit, scrollTo, syncHighlights } from "./bridge";
import { scoreLabel } from "./colors";
import { useEditorStore } from "./editorStore";
import { analyze, applyPreview, cleanText, finalizePreview, preservingScroll, resetSelection } from "./previews";

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

/** Paragraphs as the backend should see them: without inline fix previews. */
function cleanParagraphs(paragraphs: Paragraph[], blocks: Map<string, BlockRef>, proposals: Proposal[]): Paragraph[] {
  const located = analyze(blocks, proposals);
  return paragraphs.map((p) => {
    const l = located.get(p.key);
    return l ? { ...p, text: cleanText(p.text, l) } : p;
  });
}

/** Fixes whose preview has been written (or confirmed) in this editor instance. */
const previewed = new Set<string>();

/** Write red previews for pending fixes that don't have one yet. */
function reconcilePreviews(editor: Editor, root: HTMLElement | null) {
  const proposals = useApp.getState().session?.proposals ?? [];
  const { blocks } = extractParagraphs(editor);
  const todo = [...analyze(blocks, proposals)].flatMap(([para, located]) =>
    located.filter((l) => !l.lost && !previewed.has(l.proposal.id)).map((l) => ({ para, l })),
  );
  if (!todo.length) return;
  // Later positions first, so earlier ones in the same paragraph stay valid.
  todo.sort((a, b) => b.l.pos - a.l.pos);
  preservingScroll(root, () => {
    for (const { para, l } of todo) {
      const block = blocks.get(para);
      if (block && applyPreview(editor, block, l)) previewed.add(l.proposal.id);
    }
    resetSelection(editor);
  });
  useEditorStore.getState().setBlocks(extractParagraphs(editor).blocks);
}

/** Save the document without previews (pending fixes are not part of the essay yet). */
export async function saveClean(editor: Editor): Promise<ArrayBuffer> {
  const proposals = useApp.getState().session?.proposals ?? [];
  const { blocks } = extractParagraphs(editor);
  const all = [...analyze(blocks, proposals)].flatMap(([para, located]) => located.map((l) => ({ para, l })));
  all.sort((a, b) => b.l.pos - a.l.pos);
  for (const { para, l } of all) {
    const block = blocks.get(para);
    if (block) finalizePreview(editor, block, l, false);
  }
  try {
    return await editor.save();
  } finally {
    previewed.clear();
    reconcilePreviews(editor, null);
  }
}

/** One-line description of what is under the pointer. */
function brief(hits: Hit[]): { title: string; detail: string } | null {
  const s = useApp.getState().session;
  if (!s || !hits.length) return null;
  const find = (id?: string) =>
    s.annotations.find((a) => a.id === id) ?? s.proposals.find((p) => p.annotation.id === id)?.annotation;
  const para = hits[0].para;
  const score = s.annotations.find((a) => a.kind === "score" && a.para === para);
  const specific = hits.map((h) => find(h.annId)).find((a) => a && a.kind !== "score");
  const comments = s.annotations.filter((a) => a.kind === "comment" && a.para === para).length;
  const fixes = s.proposals.filter((p) => p.status === "pending" && p.annotation.para === para).length;
  const counts = [comments && `${comments} comment${comments > 1 ? "s" : ""}`, fixes && `${fixes} to review`]
    .filter(Boolean)
    .join(" · ");
  const head =
    score?.kind === "score" ? `${para} · ${Math.round(score.score * 100)} · ${scoreLabel(score.score)}` : para;
  const cut = (t: string, n = 90) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  let detail = counts;
  if (specific?.kind === "comment") detail = cut(specific.text);
  if (specific?.kind === "edit") detail = `Fix: “${cut(specific.anchor.quote, 30)}” → “${cut(specific.replacement, 30)}”`;
  return { title: head, detail: detail || "No comments" };
}

export function DocxView({
  sessionId,
  onParagraphs,
}: {
  sessionId: string;
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
  const [tip, setTip] = useState<{ x: number; y: number; title: string; detail: string } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const onParagraphsRef = useRef(onParagraphs);
  onParagraphsRef.current = onParagraphs;
  const syncTimer = useRef<number | undefined>(undefined);
  const hoverFrame = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setDoc(null);
    previewed.clear();
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
    if (import.meta.env.DEV) (window as unknown as { __editor?: Editor }).__editor = ed;
    await waitForParagraphs(ed);
    const { paragraphs, blocks } = extractParagraphs(ed);
    useEditorStore.getState().setBlocks(blocks);
    useEditorStore.getState().setEditor(ed);
    onParagraphsRef.current(cleanParagraphs(paragraphs, blocks, useApp.getState().session?.proposals ?? []));
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
      const clean = cleanParagraphs(paragraphs, blocks, session.proposals);
      if (!session.paragraphs.length || sameTexts(clean, session.paragraphs)) return;
      try {
        const snap = await api.putParagraphs(session.id, clean);
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

  // Write red previews for newly suggested fixes.
  useEffect(() => {
    if (editor && proposals) reconcilePreviews(editor, wrapRef.current);
  }, [editor, proposals]);

  const previews = useMemo(() => analyze(blocks, proposals ?? []), [blocks, proposals]);

  useEffect(() => {
    if (!editor) return;
    syncHighlights(editor, blocks, {
      annotations: annotations ?? [],
      proposals: proposals ?? [],
      showScores,
      showDetails,
      focusAnnotation,
      previews,
    });
  }, [editor, blocks, annotations, proposals, showScores, showDetails, focusAnnotation, previews]);

  useEffect(() => {
    if (editor && focusPara) scrollTo(editor, blocks.get(focusPara));
  }, [editor, blocks, focusPara]);

  const popoverRef = useRef(popover);
  popoverRef.current = popover;
  const closePopover = useCallback(() => {
    const p = popoverRef.current;
    if (!p) return;
    if (p.focusId && useApp.getState().focusAnnotation === p.focusId) useApp.setState({ focusAnnotation: null });
    setPopover(null);
  }, []);
  useEffect(() => {
    if (tab !== "essay") {
      closePopover();
      setTip(null);
    }
  }, [tab, closePopover]);

  const hitsAt = (x: number, y: number) => (editor ? annotationsAt(editor, x, y) : []);
  const isScore = (id?: string) => {
    const s = useApp.getState().session;
    return (s?.annotations.find((a) => a.id === id) ?? s?.proposals.find((p) => p.annotation.id === id)?.annotation)?.kind === "score";
  };

  // Clicking a highlighted passage opens its paragraph's details.
  const onClickCapture = (e: React.MouseEvent) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!editor || !box) return;
    const hits = hitsAt(e.clientX, e.clientY);
    if (!hits.length) {
      closePopover();
      if (useApp.getState().focusAnnotation) useApp.setState({ focusAnnotation: null });
      return;
    }
    const specific = hits.find((h) => h.annId && !isScore(h.annId));
    const anchor = (specific ?? hits[0]).rect;
    const below = anchor.bottom - box.top + 6;
    const above = below + 360 > box.height && anchor.top - box.top > 360;
    setTip(null);
    setPopover({
      para: hits[0].para,
      focusId: specific?.annId ?? null,
      left: Math.max(8, Math.min(e.clientX - box.left - 40, box.width - 340)),
      top: above ? anchor.top - box.top - 6 : below,
      above,
    });
    useApp.setState({ focusAnnotation: specific?.annId ?? null });
  };

  // Hovering shows a one-line summary.
  const onMouseMove = (e: React.MouseEvent) => {
    if (popover) return;
    const { clientX, clientY } = e;
    if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => {
      const box = wrapRef.current?.getBoundingClientRect();
      const b = brief(hitsAt(clientX, clientY));
      setTip(b && box ? { x: clientX - box.left, y: clientY - box.top, ...b } : null);
    });
  };

  if (error) return <div className="p-6 text-sm text-red-600">Could not load the document: {error}</div>;
  if (!doc) return <div className="p-6 text-sm text-stone-400">Loading document…</div>;
  return (
    <div ref={wrapRef} className="relative h-full min-h-0">
      <div
        className="h-full"
        onClickCapture={onClickCapture}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setTip(null)}
        onWheelCapture={() => {
          setTip(null);
          if (popover) closePopover();
        }}
      >
        {/* Composed rather than the all-in-one component: toolbar and pages only, without the
            title bar, menu row, navigation pane and rulers. */}
        <DocxEditor.Root document={doc} author={AUTHOR} mode="edit" onReady={onReady} onChange={onChange}>
          <div className="flex h-full flex-col">
            <DocxEditor.Toolbar className="shrink-0 border-b border-stone-100" />
            <DocxEditor.Viewport className="min-h-0 flex-1">
              <DocxEditor.Content />
            </DocxEditor.Viewport>
          </div>
        </DocxEditor.Root>
      </div>
      {tip && !popover && (
        <div
          className="pointer-events-none absolute z-30 max-w-xs rounded-md bg-stone-900 px-2.5 py-1.5 text-xs text-white shadow-lg"
          style={{ left: Math.min(tip.x + 14, (wrapRef.current?.clientWidth ?? 9999) - 300), top: tip.y + 16 }}
        >
          <div className="font-medium">{tip.title}</div>
          <div className="text-stone-300">{tip.detail}</div>
          <div className="mt-0.5 text-[10px] text-stone-400">Click for details</div>
        </div>
      )}
      {popover && <DetailsPopover state={popover} onClose={closePopover} />}
    </div>
  );
}
