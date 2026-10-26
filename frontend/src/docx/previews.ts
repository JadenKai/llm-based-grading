/**
 * Suggested fixes shown inline, like a suggestion mode: inserted text is written into the
 * document in red, removed text is struck through in red. Accepting keeps the fix in normal
 * colour; rejecting restores the original. (Real tracked changes need docx-editor's Pro
 * package, so previews are ordinary text plus formatting.)
 *
 * The backend only ever sees the clean text — the paragraph without previews. Previews are
 * recognised from the editor text itself, so they survive reloads and are never applied twice.
 */
import type { Editor, TextMatch } from "@docx-editor.dev/react";
import type { Annotation } from "../api/gen/Annotation";
import type { Proposal } from "../api/gen/Proposal";
import type { BlockRef } from "./bridge";

type Edit = Extract<Annotation, { kind: "edit" }>;
export const FIX_COLOR = "DC2626";

export interface Shape {
  quote: string;
  replacement: string;
  /** Unchanged leading part of the quote. */
  p: number;
  del: string;
  ins: string;
}

const isHighSurrogate = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  return c >= 0xd800 && c <= 0xdbff;
};

/** What the preview shows: a pure insertion or deletion at a point, or the whole quote struck and replaced. */
export function shape(quote: string, replacement: string): Shape {
  let p = 0;
  while (p < quote.length && p < replacement.length && quote[p] === replacement[p]) p++;
  if (p > 0 && isHighSurrogate(quote, p - 1)) p--;
  let q = 0;
  while (q < quote.length - p && q < replacement.length - p && quote[quote.length - 1 - q] === replacement[replacement.length - 1 - q]) q++;
  const del = quote.slice(p, quote.length - q);
  const ins = replacement.slice(p, replacement.length - q);
  // When both sides change, or only whitespace changes (a red space would be invisible),
  // strike the whole changed word(s) and write the new ones after: "~~has~~have".
  if ((del && ins) || !(del + ins).trim()) {
    let a = p;
    while (a > 0 && !/\s/.test(quote[a - 1])) a--;
    let end = quote.length - q;
    while (end < quote.length && !/\s/.test(quote[end])) end++;
    const tail = quote.length - end;
    return { quote, replacement, p: a, del: quote.slice(a, end), ins: replacement.slice(a, replacement.length - tail) };
  }
  return { quote, replacement, p, del, ins };
}

/** The text a previewed fix occupies in the editor. */
export const regionText = (s: Shape) => s.quote.slice(0, s.p) + s.del + s.ins + s.quote.slice(s.p + s.del.length);

export interface Located {
  proposal: Proposal;
  edit: Edit;
  shape: Shape;
  /** Start of the fix's region in the editor paragraph (UTF-16). */
  pos: number;
  /** The inserted text is present in the editor. */
  applied: boolean;
  /** The quote (or region) could not be found where expected. */
  lost: boolean;
}

function nearest(text: string, needle: string, near: number): number {
  let best = -1;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  }
  return best;
}

/** Locate every pending edit of one paragraph in its editor text, in document order. */
export function locate(editorText: string, edits: Proposal[]): Located[] {
  const items = edits
    .filter((p) => p.status === "pending" && p.annotation.kind === "edit")
    .map((p) => ({ proposal: p, edit: p.annotation as Edit }))
    .sort((a, b) => a.edit.anchor.start - b.edit.anchor.start);
  let shift = 0;
  return items.map(({ proposal, edit }) => {
    const s = shape(edit.anchor.quote, edit.replacement);
    const region = regionText(s);
    const expected = edit.anchor.start + shift;
    let pos = expected;
    let applied = false;
    let lost = false;
    if (s.ins && editorText.startsWith(region, expected)) applied = true;
    else if (editorText.startsWith(s.quote, expected)) applied = false;
    else {
      // Text moved (e.g. the teacher typed): fall back to the nearest occurrence.
      const r = s.ins ? nearest(editorText, region, expected) : -1;
      const q = nearest(editorText, s.quote, expected);
      if (r >= 0 && (q < 0 || Math.abs(r - expected) <= Math.abs(q - expected))) [pos, applied] = [r, true];
      else if (q >= 0) pos = q;
      else lost = true;
    }
    if (applied) shift += s.ins.length;
    return { proposal, edit, shape: s, pos, applied, lost };
  });
}

/** Editor text with the previewed insertions taken out. */
export function cleanText(editorText: string, located: Located[]): string {
  let t = editorText;
  for (const l of [...located].reverse()) {
    if (!l.applied) continue;
    const at = l.pos + l.shape.p + l.shape.del.length;
    t = t.slice(0, at) + t.slice(at + l.shape.ins.length);
  }
  return t;
}

/** Map a clean-text offset in a paragraph to the editor offset (after previewed insertions). */
export function toEditorOffset(located: Located[] | undefined, cleanOffset: number): number {
  let out = cleanOffset;
  for (const l of located ?? []) {
    if (!l.applied) continue;
    const insertAt = l.edit.anchor.start + l.shape.p + l.shape.del.length;
    if (insertAt <= cleanOffset) out += l.shape.ins.length;
  }
  return out;
}

export function analyze(blocks: Map<string, BlockRef>, proposals: Proposal[]): Map<string, Located[]> {
  const byPara = new Map<string, Proposal[]>();
  for (const p of proposals) {
    if (p.status !== "pending" || p.annotation.kind !== "edit") continue;
    byPara.set(p.annotation.para, [...(byPara.get(p.annotation.para) ?? []), p]);
  }
  const out = new Map<string, Located[]>();
  for (const [para, edits] of byPara) {
    const block = blocks.get(para);
    if (block) out.set(para, locate(block.text, edits));
  }
  return out;
}

// --- Editor operations ---------------------------------------------------------------------

function matchAt(editor: Editor, block: BlockRef, text: string, start: number): TextMatch | undefined {
  if (!text || !block.blockId) return undefined;
  return editor
    .findMatches(text, { matchCase: true })
    .find((m) => !m.scope && m.blockId === block.blockId && m.start === start);
}

/** Select `text` at `start` and set its colour and strike-through. */
function format(editor: Editor, block: BlockRef, text: string, start: number, color: string, strike: boolean) {
  const m = matchAt(editor, block, text, start);
  if (!m || !editor.selectMatch(m).ok) return false;
  editor.exec({ type: "setMarkAttr", mark: "color", attr: "val", value: color });
  const struck = !!editor.query({ type: "selectionFormatting" })?.strike;
  if (struck !== strike) editor.exec({ type: "toggleMark", mark: "strike" });
  return true;
}

/** Write one fix into the document as a red preview. Idempotent. */
export function applyPreview(editor: Editor, block: BlockRef, l: Located): boolean {
  if (l.lost) return false;
  const s = l.shape;
  if (s.ins && !l.applied) {
    const m = matchAt(editor, block, s.quote, l.pos);
    if (!m || !editor.exec({ type: "replaceMatch", match: m, text: regionText(s) }).ok) return false;
  }
  let ok = true;
  if (s.del) ok = format(editor, block, s.del, l.pos + s.p, FIX_COLOR, true) && ok;
  if (s.ins) ok = format(editor, block, s.ins, l.pos + s.p + s.del.length, FIX_COLOR, false) && ok;
  return ok;
}

/** Resolve a fix: keep the replacement (accept) or the original (reject), in normal colour. */
export function finalizePreview(editor: Editor, block: BlockRef, l: Located, accept: boolean): string | null {
  if (l.lost) return `"${l.shape.quote}" is no longer in the paragraph`;
  const s = l.shape;
  const current = l.applied ? regionText(s) : s.quote;
  const final = accept ? s.replacement : s.quote;
  const m = matchAt(editor, block, current, l.pos);
  if (!m) return `"${current}" is no longer in the paragraph`;
  if (current !== final) {
    const r = editor.exec({ type: "replaceMatch", match: m, text: final });
    if (!r.ok) return `${r.code}: ${r.reason}`;
  }
  if (final) format(editor, block, final, l.pos, "auto", false);
  return null;
}

/** Put the caret back at the start of the document, so typing doesn't pick up red/strike formatting. */
export function resetSelection(editor: Editor) {
  const first = editor.query({ type: "paragraphs" }).find((p) => p.paraId);
  if (first?.paraId) editor.exec({ type: "setSelection", anchor: { paraId: first.paraId } });
}

/** Keep the viewport where it is while previews move the selection around. */
export function preservingScroll(root: HTMLElement | null, fn: () => void) {
  const scrollers = root
    ? [...root.querySelectorAll<HTMLElement>("*")].filter((el) => el.scrollHeight > el.clientHeight + 4)
    : [];
  const saved = scrollers.map((el) => [el, el.scrollTop, el.scrollLeft] as const);
  try {
    fn();
  } finally {
    for (const [el, top, left] of saved) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  }
}
