import { useState } from "react";
import type { Assessment } from "../../api/gen/Assessment";
import type { ScoreOverride } from "../../api/gen/ScoreOverride";

export const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function band(pct: number) {
  if (pct >= 0.9) return "Excellent";
  if (pct >= 0.8) return "Strong";
  if (pct >= 0.7) return "Proficient";
  if (pct >= 0.6) return "Developing";
  return "Needs work";
}

export interface FinalCriterion {
  name: string;
  max: number;
  /** The model's score (from the frozen original assessment). */
  ai: number;
  /** The score that counts: the instructor's override, else the model's. */
  score: number;
  override: ScoreOverride | null;
  justification: string;
}

/** Apply the instructor's overrides to the original assessment. */
export function finalScores(a: Assessment, overrides: ScoreOverride[] = []) {
  const criteria: FinalCriterion[] = a.criteria.map((c) => {
    const o = overrides.find((x) => x.criterion === c.name) ?? null;
    return { name: c.name, max: c.max, ai: c.score, score: o ? o.score : c.score, override: o, justification: c.justification };
  });
  const overall = criteria.reduce((s, c) => s + c.score, 0);
  const aiOverall = criteria.reduce((s, c) => s + c.ai, 0);
  return { criteria, overall, aiOverall, max: a.max, adjusted: criteria.some((c) => c.override) };
}

/**
 * The verdict: the score as a hero figure, then one meter per rubric criterion (score against
 * its maximum). With instructor overrides the meters show the final scores, with a tick where
 * the model's score was. One neutral fill — the meters compare magnitudes, not status.
 */
export function VerdictWidget({
  assessment,
  overrides = [],
  compact = false,
}: {
  assessment: Assessment;
  overrides?: ScoreOverride[];
  compact?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const f = finalScores(assessment, overrides);
  const pct = f.max > 0 ? f.overall / f.max : 0;
  return (
    <figure className={compact ? "space-y-3" : "space-y-5"} aria-label="Final verdict">
      <div className="flex items-end gap-3">
        <span className={`${compact ? "text-4xl" : "text-6xl"} leading-none font-semibold tracking-tight text-stone-900`}>
          {num(f.overall)}
        </span>
        <div className="pb-0.5 text-sm leading-tight text-stone-500">
          <div>of {num(f.max)}</div>
          <div>
            {Math.round(pct * 100)}% · <span className="text-stone-800">{band(pct)}</span>
          </div>
        </div>
        {f.adjusted && (
          <div className="ml-auto pb-0.5 text-right text-xs leading-tight text-stone-500">
            <div className="font-medium text-stone-800">Adjusted by instructor</div>
            <div>AI score {num(f.aiOverall)}</div>
          </div>
        )}
      </div>
      <ul className="space-y-1.5">
        {f.criteria.map((c, i) => {
          const p = c.max > 0 ? Math.min(1, Math.max(0, c.score / c.max)) : 0;
          const aiP = c.max > 0 ? Math.min(1, Math.max(0, c.ai / c.max)) : 0;
          return (
            <li
              key={c.name}
              className="relative grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 rounded py-0.5 text-xs"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <span className="truncate text-stone-600" title={c.name}>
                {c.name}
              </span>
              <span className="relative h-1.5 rounded-full bg-stone-200" aria-hidden>
                <span className="block h-full rounded-full bg-stone-800" style={{ width: `${p * 100}%` }} />
                {c.override && c.ai !== c.score && (
                  <span
                    className="absolute -top-1 h-3.5 w-0.5 rounded-full bg-stone-400"
                    style={{ left: `calc(${aiP * 100}% - 1px)` }}
                    title={`AI score ${num(c.ai)}`}
                  />
                )}
              </span>
              <span className="tabular-nums text-stone-700">
                {num(c.score)} / {num(c.max)}
                {c.override && <span className="ml-1 text-stone-400">(AI {num(c.ai)})</span>}
              </span>
              {hover === i && (c.justification || c.override?.note) && (
                <span className="absolute top-full left-0 z-20 mt-1 max-w-sm space-y-1 rounded-md bg-stone-900 px-2.5 py-1.5 text-xs text-white shadow-lg">
                  {c.override?.note && <span className="block">Instructor: {c.override.note}</span>}
                  {c.justification && <span className="block text-stone-300">AI: {c.justification}</span>}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
