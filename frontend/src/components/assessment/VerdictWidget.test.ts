import { describe, expect, it } from "vitest";
import type { Assessment } from "../../api/gen/Assessment";
import { finalScores } from "./VerdictWidget";

const assessment: Assessment = {
  thesis: "",
  overall: 7,
  max: 10,
  summary: "",
  strengths: [],
  improvements: [],
  criteria: [
    { name: "Thesis", score: 4, max: 5, justification: "", evidence: [] },
    { name: "Evidence", score: 3, max: 5, justification: "", evidence: [] },
  ],
  model: { provider_id: "p", model: "m" },
  created_at: "",
};

describe("finalScores", () => {
  it("uses the model's scores when nothing is overridden", () => {
    const f = finalScores(assessment);
    expect([f.overall, f.aiOverall, f.adjusted]).toEqual([7, 7, false]);
  });

  it("replaces overridden criteria and keeps the AI scores on record", () => {
    const f = finalScores(assessment, [{ criterion: "Evidence", score: 4.5, note: "Fine.", updated_at: "" }]);
    expect(f.overall).toBe(8.5);
    expect(f.aiOverall).toBe(7);
    expect(f.adjusted).toBe(true);
    expect(f.criteria[1]).toMatchObject({ ai: 3, score: 4.5, override: { note: "Fine." } });
    expect(f.criteria[0].override).toBeNull();
  });
});
