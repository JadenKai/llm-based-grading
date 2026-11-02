import { useState } from "react";
import { api } from "../../api/client";
import type { ScoreOverride } from "../../api/gen/ScoreOverride";
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

/** A criterion's score, with the instructor's override (if any) and an editor for it. */
function CriterionScore({ name, ai, max, override }: { name: string; ai: number; max: number; override: ScoreOverride | null }) {
  const sessionId = useApp((s) => s.session?.id);
  const setOverrides = useApp((s) => s.setOverrides);
  const [editing, setEditing] = useState(false);
  const [score, setScore] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setScore(num(override?.score ?? ai));
    setNote(override?.note ?? "");
    setError(null);
    setEditing(true);
  };
  const save = async (value: number | null) => {
    if (!sessionId) return;
    if (value !== null && !(value >= 0 && value <= max)) return setError(`Enter a score from 0 to ${num(max)}.`);
    setBusy(true);
    setError(null);
    try {
      setOverrides(await api.setOverride(sessionId, { criterion: name, score: value, note: value === null ? undefined : note }));
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-4">
        <h4 className="text-sm font-medium text-stone-900">{name}</h4>
        <div className="flex items-baseline gap-3 text-sm tabular-nums">
          {override ? (
            <>
              <span className="text-xs text-stone-400 line-through" title="AI score">
                {num(ai)}
              </span>
              <span className="font-medium text-stone-900" title="Instructor score">
                {num(override.score)} / {num(max)}
              </span>
            </>
          ) : (
            <span className="text-stone-500">
              {num(ai)} / {num(max)}
            </span>
          )}
          {!editing && (
            <button type="button" onClick={open} className="text-xs text-stone-500 hover:text-stone-900">
              {override ? "Edit" : "Override"}
            </button>
          )}
        </div>
      </div>
      {override && !editing && (
        <p className="border-l-[3px] border-stone-900 pl-2 text-xs text-stone-700">
          <span className="font-semibold text-stone-900">Instructor</span>
          {override.note ? ` — ${override.note}` : " adjusted this score."}
        </p>
      )}
      {editing && (
        <div className="space-y-2 rounded-lg bg-stone-50 p-3 ring-1 ring-stone-200">
          <div className="flex items-center gap-2 text-sm">
            <label className="text-xs text-stone-500" htmlFor={`ov-${name}`}>
              Score
            </label>
            <input
              id={`ov-${name}`}
              type="number"
              min={0}
              max={max}
              step={0.5}
              autoFocus
              value={score}
              onChange={(e) => setScore(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save(parseFloat(score))}
              className="w-20 rounded-md border border-stone-300 px-2 py-1 tabular-nums outline-none focus:border-stone-500"
            />
            <span className="text-stone-500">/ {num(max)}</span>
            <span className="ml-auto text-xs text-stone-400">AI: {num(ai)}</span>
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save(parseFloat(score))}
            placeholder="Reason (optional, shared with the chat agent)"
            className="w-full rounded-md border border-stone-300 px-2 py-1 text-sm outline-none focus:border-stone-500"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => save(parseFloat(score))}
              className="rounded-md bg-stone-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-stone-700 disabled:bg-stone-300"
            >
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)} className="text-xs text-stone-500 hover:text-stone-900">
              Cancel
            </button>
            {override && (
              <button
                type="button"
                disabled={busy}
                onClick={() => save(null)}
                className="ml-auto text-xs text-stone-500 hover:text-red-600"
              >
                Reset to AI score
              </button>
            )}
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}
    </div>
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
        <VerdictWidget assessment={a} overrides={session.overrides} />
        <div className="space-y-2">
          <Markdown className="text-sm text-stone-700">{a.summary}</Markdown>
          <p className="text-xs text-stone-400">
            Thesis: <span className="italic text-stone-500">{a.thesis}</span>
          </p>
        </div>

        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h3 className="text-xs font-medium text-stone-500">Criteria</h3>
            <span className="text-xs text-stone-400">Override any score; the AI's original stays on record.</span>
          </div>
          <ol className="divide-y divide-stone-200 border-y border-stone-200">
            {a.criteria.map((c) => (
              <li key={c.name} className="space-y-1 py-3">
                <CriterionScore
                  name={c.name}
                  ai={c.score}
                  max={c.max}
                  override={session.overrides.find((o) => o.criterion === c.name) ?? null}
                />
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
          Graded by <span className="font-mono">{a.model.model}</span> · {new Date(a.created_at).toLocaleString()} · the AI's
          assessment is frozen; instructor overrides are kept alongside it.
        </p>
      </div>
    </div>
  );
}
