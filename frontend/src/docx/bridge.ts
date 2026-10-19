/**
 * The only module that talks to the docx-editor API. Maps our paragraph keys (P1, P2, …) to
 * the editor's block ids, paints annotations as highlight sets, and applies accepted edits.
 */
import type { Editor, HighlightRange, TextMatch } from "@docx-editor.dev/react";
import type { Annotation } from "../api/gen/Annotation";
import type { Anchor } from "../api/gen/Anchor";
import type { Paragraph } from "../api/gen/Paragraph";
import type { Proposal } from "../api/gen/Proposal";
import { bucket, scoreColor } from "./colors";

export interface BlockRef {
  key: string;
  blockId: string | null;
  text: string;
}

export interface Extracted {
  paragraphs: Paragraph[];
  blocks: Map<string, BlockRef>;
}

/** Highlight ranges carry the annotation they paint so clicks can be resolved. */
type Range = HighlightRange & { annId?: string; para: string };

const QUERY_CODEPOINTS = 64;

/**
 * Read body paragraphs and find each one's block id. The editor exposes paragraph text and
 * block-addressed search separately, so each paragraph's opening text is searched for and the
 * match at offset 0, in document order, is taken as its block.
 */
export function extractParagraphs(editor: Editor): Extracted {
  const summaries = editor.query({ type: "paragraphs" });
  const nonEmpty = summaries.filter((p) => p.text.trim().length > 0);
  const queries = nonEmpty.map((p) => Array.from(p.text).slice(0, QUERY_CODEPOINTS).join(""));
  let lists: readonly (readonly TextMatch[])[] = [];
  try {
    lists = queries.length ? editor.findMatches(queries, { matchCase: true }) : [];
  } catch (e) {
    console.warn("findMatches failed; highlights disabled", e);
  }

  const used = new Set<string>();
  let minIndex = 0;
  const paragraphs: Paragraph[] = [];
  const blocks = new Map<string, BlockRef>();
  nonEmpty.forEach((p, i) => {
    const cands = (lists[i] ?? []).filter((m) => !m.scope && m.start === 0 && !used.has(m.blockId));
    const inOrder = cands.filter((m) => m.paragraphIndex >= minIndex).sort((a, b) => a.paragraphIndex - b.paragraphIndex);
    const match = inOrder[0] ?? cands[0];
    if (match) {
      used.add(match.blockId);
      minIndex = match.paragraphIndex + 1;
    }
    const key = `P${i + 1}`;
    paragraphs.push({ key, index: i, text: p.text });
    blocks.set(key, { key, blockId: match?.blockId ?? null, text: p.text });
  });
  return { paragraphs, blocks };
}

const SCORE_SETS = Array.from({ length: 11 }, (_, b) => `score-${b}`);

function anchorRange(block: BlockRef, anchor: Anchor | null, annId: string): Range | null {
  if (!block.blockId) return null;
  if (!anchor) {
    return { blockId: block.blockId, start: 0, length: block.text.length, annId, para: block.key };
  }
  if (anchor.length === 0) return null;
  return {
    blockId: block.blockId,
    start: anchor.start,
    length: anchor.length,
    expectedText: anchor.quote,
    annId,
    para: block.key,
  };
}

export interface HighlightState {
  annotations: Annotation[];
  proposals: Proposal[];
  showScores: boolean;
  focusAnnotation: string | null;
}

/** Repaint every highlight set from scratch. Cheap: a few dozen ranges. */
export function syncHighlights(editor: Editor, blocks: Map<string, BlockRef>, st: HighlightState) {
  const scoreRanges: Range[][] = SCORE_SETS.map(() => []);
  const comments: Range[] = [];
  const harperEdits: Range[] = [];
  const agentPending: Range[] = [];
  const pendingScores: Range[] = [];
  const focus: Range[] = [];

  const visit = (a: Annotation, pending: boolean) => {
    const block = blocks.get(a.para);
    if (!block) return;
    let r: Range | null = null;
    switch (a.kind) {
      case "score":
        r = anchorRange(block, null, a.id);
        if (r && st.showScores && !pending) scoreRanges[bucket(a.score)].push(r);
        // A proposed re-score is outlined; the current score colour stays visible underneath.
        if (r && pending) pendingScores.push(r);
        break;
      case "comment":
        r = anchorRange(block, a.anchor, a.id);
        if (r && a.anchor) (pending ? agentPending : comments).push(r);
        break;
      case "edit":
        r = anchorRange(block, a.anchor, a.id);
        if (r) (a.source === "harper" ? harperEdits : agentPending).push(r);
        break;
    }
    if (r && st.focusAnnotation === a.id) focus.push(r);
  };
  for (const a of st.annotations) visit(a, false);
  for (const p of st.proposals) if (p.status === "pending") visit(p.annotation, true);

  const set = (name: string, ranges: Range[], color: string, className: string, priority: number) => {
    try {
      if (ranges.length) editor.setHighlights(name, ranges, { color, className, priority });
      else editor.clearHighlights(name);
    } catch (e) {
      console.warn(`highlight set ${name} failed`, e);
    }
  };
  SCORE_SETS.forEach((name, b) => set(name, scoreRanges[b], scoreColor(b), "grader-score", 0));
  set("comments", comments, "oklch(0.86 0.08 250)", "grader-comment", 3);
  set("grammar", harperEdits, "oklch(0.86 0.12 20)", "grader-grammar", 4);
  set("proposals", agentPending, "oklch(0.86 0.1 300)", "grader-proposal", 5);
  set("pending-scores", pendingScores, "transparent", "grader-proposal", 2);
  set("focus", focus, "oklch(0.83 0.15 60)", "grader-focus", 10);
}

/** Annotation ids under a client point, topmost first. */
export function annotationsAt(editor: Editor, x: number, y: number): { annId?: string; para: string }[] {
  try {
    return editor.getHighlightsAt<Range>(x, y).map((h) => ({ annId: h.range.annId, para: h.range.para }));
  } catch {
    return [];
  }
}

export function scrollTo(editor: Editor, block: BlockRef | undefined) {
  if (block?.blockId) editor.scrollToBlock(block.blockId, { block: "center", behavior: "smooth" });
}

/** Apply an accepted edit in the document. Returns the error reason, or null on success. */
export function applyEdit(editor: Editor, block: BlockRef, anchor: Anchor, replacement: string): string | null {
  if (!block.blockId) return "this paragraph could not be located in the editor";
  const matches = editor
    .findMatches(anchor.quote, { matchCase: true })
    .filter((m) => !m.scope && m.blockId === block.blockId);
  if (!matches.length) return `"${anchor.quote}" is no longer in the paragraph`;
  const best = matches.reduce((a, b) => (Math.abs(b.start - anchor.start) < Math.abs(a.start - anchor.start) ? b : a));
  const res = editor.exec({ type: "replaceMatch", match: best, text: replacement });
  return res.ok ? null : `${res.code}: ${res.reason}`;
}
