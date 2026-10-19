import { scoreColorFor, scoreInkFor } from "../../docx/colors";
import { useApp } from "../../stores/app";
import { Markdown } from "../Markdown";

export function AssessmentView() {
  const session = useApp((s) => s.session);
  const running = useApp((s) => s.activeRunId !== null);
  const a = session?.assessment;

  if (!a) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-stone-500">
        {running ? "The assessment will appear here when grading finishes…" : "This essay has not been graded yet."}
      </div>
    );
  }
  const pct = a.max > 0 ? a.overall / a.max : 0;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-6">
        <header className="flex items-start gap-5">
          <div
            className="flex h-24 w-24 shrink-0 flex-col items-center justify-center rounded-2xl"
            style={{ background: scoreColorFor(pct), color: scoreInkFor(pct) }}
          >
            <span className="text-3xl font-bold">{a.overall.toFixed(a.overall % 1 ? 1 : 0)}</span>
            <span className="text-xs font-medium">of {a.max.toFixed(a.max % 1 ? 1 : 0)}</span>
          </div>
          <div className="min-w-0 space-y-1">
            <h2 className="text-lg font-semibold text-stone-900">Original assessment</h2>
            <p className="text-xs text-stone-500">
              Graded by <span className="font-mono">{a.model.model}</span> on {new Date(a.created_at).toLocaleString()}.
              This snapshot is frozen; later chat changes do not alter it.
            </p>
            <Markdown className="text-sm text-stone-700">{a.summary}</Markdown>
          </div>
        </header>

        <section className="rounded-xl border border-stone-200 bg-stone-50 p-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">Thesis</h3>
          <p className="text-sm italic text-stone-800">{a.thesis}</p>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Rubric criteria</h3>
          {a.criteria.map((c) => {
            const p = c.max > 0 ? c.score / c.max : 0;
            return (
              <div key={c.name} className="rounded-xl border border-stone-200 p-4">
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <h4 className="font-medium text-stone-900">{c.name}</h4>
                  <span className="font-mono text-sm font-semibold" style={{ color: scoreInkFor(p) }}>
                    {c.score} / {c.max}
                  </span>
                </div>
                <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-stone-100">
                  <div className="h-full rounded-full" style={{ width: `${p * 100}%`, background: scoreInkFor(p) }} />
                </div>
                <Markdown className="text-sm text-stone-700">{c.justification}</Markdown>
                {c.evidence.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {c.evidence.map((e, i) => (
                      <li key={i} className="border-l-2 border-stone-200 pl-2 text-xs text-stone-600">
                        <Markdown>{e}</Markdown>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </section>

        <div className="grid gap-4 sm:grid-cols-2">
          <section className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-700">Strengths</h3>
            <ul className="list-disc space-y-1 pl-4 text-sm text-stone-700">
              {a.strengths.map((s, i) => (
                <li key={i}>
                  <Markdown>{s}</Markdown>
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-xl border border-amber-200 bg-amber-50/50 p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-700">To improve</h3>
            <ul className="list-disc space-y-1 pl-4 text-sm text-stone-700">
              {a.improvements.map((s, i) => (
                <li key={i}>
                  <Markdown>{s}</Markdown>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
