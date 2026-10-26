import { describe, expect, it } from "vitest";
import type { Proposal } from "../api/gen/Proposal";
import { cleanText, locate, regionText, shape, toEditorOffset } from "./previews";

const edit = (id: string, start: number, quote: string, replacement: string): Proposal => ({
  id,
  status: "pending",
  note: null,
  annotation: {
    kind: "edit",
    id: `a${id}`,
    para: "P1",
    anchor: { start, length: quote.length, quote },
    replacement,
    reason: "",
    source: "harper",
    lint_kind: null,
  },
});

describe("shape", () => {
  it("shows insertions, deletions and replacements", () => {
    expect(shape("clubs", "clubs,")).toMatchObject({ p: 5, del: "", ins: "," });
    expect(shape("an", "a")).toMatchObject({ p: 1, del: "n", ins: "" });
    expect(shape("teh", "the")).toMatchObject({ p: 0, del: "teh", ins: "the" });
    expect(regionText(shape("teh", "the"))).toBe("tehthe");
    expect(regionText(shape("clubs", "clubs,"))).toBe("clubs,");
  });

  it("strikes and replaces only the changed word", () => {
    expect(shape("Students who has more rest", "Students who have more rest")).toMatchObject({ p: 13, del: "has", ins: "have" });
    expect(regionText(shape("Students who has more rest", "Students who have more rest"))).toBe("Students who hashave more rest");
  });

  it("replaces the whole word when only whitespace changes", () => {
    expect(shape("wellbeing", "well being")).toMatchObject({ p: 0, del: "wellbeing", ins: "well being" });
  });
});

describe("locate / cleanText", () => {
  const clean = "Use clubs and teh rest.";
  const edits = [edit("1", 4, "clubs", "clubs,"), edit("2", 14, "teh", "the")];

  it("finds unapplied fixes in clean text", () => {
    const l = locate(clean, edits);
    expect(l.map((x) => [x.pos, x.applied])).toEqual([
      [4, false],
      [14, false],
    ]);
    expect(cleanText(clean, l)).toBe(clean);
  });

  it("recognises applied previews and strips them", () => {
    const shown = "Use clubs, and tehthe rest.";
    const l = locate(shown, edits);
    expect(l.map((x) => [x.pos, x.applied])).toEqual([
      [4, true],
      [15, true],
    ]);
    expect(cleanText(shown, l)).toBe(clean);
    // A comment anchored after both fixes moves by the inserted text.
    expect(toEditorOffset(l, 18)).toBe(18 + 1 + 3);
    expect(toEditorOffset(l, 4)).toBe(4);
  });

  it("follows text that moved and flags text that is gone", () => {
    const moved = "Now use clubs, and teh rest.";
    const l = locate(moved, edits);
    expect(l[0]).toMatchObject({ pos: 8, applied: true, lost: false });
    expect(locate("Nothing here.", edits).every((x) => x.lost)).toBe(true);
  });
});
