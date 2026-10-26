import { useApp } from "../../stores/app";
import { Markdown } from "../Markdown";
import { VerdictWidget } from "./VerdictWidget";

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-stone-500">{title}</h3>
      <ul className="list-disc space-y-1 pl-4 text-sm text-stone-700">
        {items.map((s, i) => (
          <li key={i}>
            <Markdown>{s}</Markdown>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AssessmentView() {
  const session = useApp((s) => s.session);
  const running = useApp((s) => s.activeRunId !== null);
  const a = session?.assessment;

  if (!a) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-stone-400">
        {running ? "The assessment appears here when grading finishes." : "This essay has not been graded yet."}
      </div>
    );
  }
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-8 px-6 py-8">
        <VerdictWidget assessment={a} />
        <div className="space-y-2">
          <Markdown className="text-sm text-stone-700">{a.summary}</Markdown>
          <p className="text-xs text-stone-400">
            Thesis: <span className="italic text-stone-500">{a.thesis}</span>
          </p>
        </div>

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-stone-500">Criteria</h3>
          <ol className="divide-y divide-stone-200 border-y border-stone-200">
            {a.criteria.map((c) => (
              <li key={c.name} className="space-y-1 py-3">
                <div className="flex items-baseline justify-between gap-4">
                  <h4 className="text-sm font-medium text-stone-900">{c.name}</h4>
                  <span className="text-sm tabular-nums text-stone-500">
                    {num(c.score)} / {num(c.max)}
                  </span>
                </div>
                <Markdown className="text-sm text-stone-600">{c.justification}</Markdown>
                {c.evidence.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-stone-500">
                    {c.evidence.map((e, i) => (
                      <li key={i}>
                        <Markdown>{e}</Markdown>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </section>

        <div className="grid gap-6 sm:grid-cols-2">
          <List title="Strengths" items={a.strengths} />
          <List title="To improve" items={a.improvements} />
        </div>

        <p className="text-xs text-stone-400">
          Graded by <span className="font-mono">{a.model.model}</span> · {new Date(a.created_at).toLocaleString()} · frozen;
          later chat changes do not alter it.
        </p>
      </div>
    </div>
  );
}
