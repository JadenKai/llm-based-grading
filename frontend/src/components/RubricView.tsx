import type { Rubric } from "../api/gen/Rubric";
import { useApp } from "../stores/app";
import { Markdown } from "./Markdown";

const pts = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function Structured({ rubric }: { rubric: Rubric }) {
  const total = rubric.criteria.reduce((a, c) => a + c.points, 0);
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold text-stone-900">{rubric.title}</h2>
        <p className="text-sm text-stone-500">
          {rubric.criteria.length} criteria · {pts(total)} points
          {rubric.description ? ` · ${rubric.description}` : ""}
        </p>
      </header>
      <ol className="divide-y divide-stone-200 border-y border-stone-200">
        {rubric.criteria.map((c) => (
          <li key={c.name} className="space-y-2 py-4">
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="font-medium text-stone-900">{c.name}</h3>
              <span className="shrink-0 text-sm tabular-nums text-stone-500">{pts(c.points)} pts</span>
            </div>
            {c.description && <p className="text-sm text-stone-600">{c.description}</p>}
            {c.levels.length > 0 && (
              <table className="w-full text-sm">
                <tbody>
                  {c.levels.map((l) => (
                    <tr key={l.label} className="align-top">
                      <td className="w-28 py-1 pr-3 text-stone-500">{l.label}</td>
                      <td className="w-12 py-1 pr-3 tabular-nums text-stone-400">{l.points != null ? pts(l.points) : ""}</td>
                      <td className="py-1 text-stone-700">{l.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        ))}
      </ol>
      {rubric.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-stone-600">
          {rubric.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RubricView() {
  const session = useApp((s) => s.session);
  if (!session) return null;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        {session.rubric ? (
          <Structured rubric={session.rubric} />
        ) : (
          <Markdown className="text-sm text-stone-800">{session.rubricMd}</Markdown>
        )}
      </div>
    </div>
  );
}
