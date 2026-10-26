import { useState } from "react";
import type { Assessment } from "../../api/gen/Assessment";

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function band(pct: number) {
  if (pct >= 0.9) return "Excellent";
  if (pct >= 0.8) return "Strong";
  if (pct >= 0.7) return "Proficient";
  if (pct >= 0.6) return "Developing";
  return "Needs work";
}

/**
 * The final verdict: the overall score as a hero figure, then one meter per rubric criterion
 * (score against its maximum). One neutral fill — the meters compare magnitudes, they don't
 * signal status — with exact values printed beside each bar and the justification on hover.
 */
export function VerdictWidget({ assessment, compact = false }: { assessment: Assessment; compact?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const pct = assessment.max > 0 ? assessment.overall / assessment.max : 0;
  return (
    <figure className={compact ? "space-y-3" : "space-y-5"} aria-label="Final verdict">
      <div className="flex items-end gap-3">
        <span className={`${compact ? "text-4xl" : "text-6xl"} leading-none font-semibold tracking-tight text-stone-900`}>
          {num(assessment.overall)}
        </span>
        <div className="pb-0.5 text-sm leading-tight text-stone-500">
          <div>of {num(assessment.max)}</div>
          <div>
            {Math.round(pct * 100)}% · <span className="text-stone-800">{band(pct)}</span>
          </div>
        </div>
      </div>
      <ul className="space-y-1.5">
        {assessment.criteria.map((c, i) => {
          const p = c.max > 0 ? Math.min(1, Math.max(0, c.score / c.max)) : 0;
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
              <span className="h-1.5 rounded-full bg-stone-200" aria-hidden>
                <span className="block h-full rounded-full bg-stone-800" style={{ width: `${p * 100}%` }} />
              </span>
              <span className="tabular-nums text-stone-700">
                {num(c.score)} / {num(c.max)}
              </span>
              {hover === i && c.justification && (
                <span className="absolute top-full left-0 z-20 mt-1 max-w-sm rounded-md bg-stone-900 px-2.5 py-1.5 text-xs text-white shadow-lg">
                  {c.justification}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
