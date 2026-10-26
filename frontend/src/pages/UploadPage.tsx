import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type Source } from "../api/client";
import { ModelPicker } from "../components/ModelPicker";
import { usePrefs } from "../stores/app";

/** One input: pick a bundled example from the dropdown, or upload / drop a file. */
function SourceField({
  label,
  placeholder,
  options,
  accept,
  uploadLabel,
  value,
  onChange,
  validate,
}: {
  label: string;
  placeholder: string;
  options: { id: string; name: string; detail?: string }[];
  accept: string;
  uploadLabel: string;
  value: Source | null;
  onChange: (s: Source | null) => void;
  validate: (f: File) => string | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const take = (f: File) => {
    const err = validate(f);
    setError(err);
    if (!err) onChange(f);
  };
  const file = value instanceof File ? value : null;
  const preset = value && !(value instanceof File) ? value.preset : "";

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) take(f);
      }}
      className={`space-y-1.5 rounded-lg p-3 transition ${over ? "bg-stone-100 ring-1 ring-stone-300" : ""}`}
    >
      <label className="block text-xs font-medium text-stone-500">{label}</label>
      <div className="flex items-center gap-2">
        <select
          value={preset}
          onChange={(e) => {
            setError(null);
            onChange(e.target.value ? { preset: e.target.value } : null);
          }}
          className="min-w-0 flex-1 rounded-md border border-stone-300 bg-white px-2.5 py-2 text-sm text-stone-800 outline-none focus:border-stone-500"
        >
          <option value="">{file ? `Uploaded: ${file.name}` : placeholder}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.detail ? ` — ${o.detail}` : ""}
            </option>
          ))}
        </select>
        <span className="text-xs text-stone-400">or</span>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className={`shrink-0 rounded-md px-3 py-2 text-sm ring-1 ${
            file ? "bg-stone-900 text-white ring-stone-900" : "text-stone-700 ring-stone-300 hover:bg-stone-50"
          }`}
        >
          {uploadLabel}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.[0]) take(e.target.files[0]);
            e.target.value = "";
          }}
        />
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

export function UploadPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [essay, setEssay] = useState<Source | null>(null);
  const [rubric, setRubric] = useState<Source | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = usePrefs((s) => s.model);
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.listSessions });
  const presets = useQuery({ queryKey: ["presets"], queryFn: api.presets, staleTime: Infinity });

  const submit = async () => {
    if (!essay || !rubric) return;
    setBusy(true);
    setError(null);
    try {
      const { session_id } = await api.createSession(essay, rubric);
      qc.invalidateQueries({ queryKey: ["sessions"] });
      navigate(`/grade/${session_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="flex items-center justify-between px-6 py-4 text-sm">
        <span className="font-semibold tracking-tight text-stone-800">Essay Grader</span>
        <Link to="/settings" className="text-stone-500 hover:text-stone-900">
          Settings
        </Link>
      </header>
      <main className="mx-auto max-w-xl space-y-8 px-6 pt-12 pb-16">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-stone-900">Grade an essay</h1>
          <p className="text-sm text-stone-500">Choose an example or upload your own essay and rubric.</p>
        </div>

        <div className="space-y-1 rounded-xl bg-white p-2 ring-1 ring-stone-200">
          <SourceField
            label="Essay"
            placeholder="Choose an example essay…"
            options={(presets.data?.essays ?? []).map((e) => ({ id: e.id, name: e.name }))}
            accept=".docx"
            uploadLabel="Upload .docx"
            value={essay}
            onChange={setEssay}
            validate={(f) => (f.name.toLowerCase().endsWith(".docx") ? null : "The essay must be a .docx file.")}
          />
          <SourceField
            label="Rubric"
            placeholder="Choose a rubric…"
            options={(presets.data?.rubrics ?? []).map((r) => ({
              id: r.id,
              name: r.name,
              detail: `${r.criteria} criteria, ${fmt(r.total_points)} pts`,
            }))}
            accept=".json,application/json"
            uploadLabel="Upload .json"
            value={rubric}
            onChange={setRubric}
            validate={(f) => (f.name.toLowerCase().endsWith(".json") ? null : "The rubric must be a .json file.")}
          />
          <div className="flex items-center justify-between gap-3 border-t border-stone-100 px-3 pt-3 pb-1">
            <div className="flex items-center gap-1 text-xs text-stone-500">
              Model
              <ModelPicker direction="down" />
            </div>
            <button
              type="button"
              disabled={!essay || !rubric || !model || busy}
              onClick={submit}
              className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:bg-stone-300"
            >
              {busy ? "Uploading…" : "Grade"}
            </button>
          </div>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <p className="text-xs text-stone-400">
          Rubrics are JSON:{" "}
          <code className="text-stone-500">
            {'{"title": …, "criteria": [{"name": …, "points": …, "description": …}]}'}
          </code>
          . See <code className="text-stone-500">examples/rubrics/</code>.
        </p>

        {!!sessions.data?.length && (
          <section className="space-y-2">
            <h2 className="text-xs font-medium text-stone-500">Recent</h2>
            <ul className="divide-y divide-stone-100 overflow-hidden rounded-xl bg-white ring-1 ring-stone-200">
              {sessions.data.slice(0, 12).map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <Link to={`/grade/${s.id}`} className="flex-1 truncate text-stone-800 hover:underline">
                    {s.essay_name}
                  </Link>
                  <span className="text-xs tabular-nums text-stone-500">
                    {s.graded && s.overall != null ? `${fmt(s.overall)} / ${fmt(s.max ?? 0)}` : "not graded"}
                  </span>
                  <span className="text-xs text-stone-400">{new Date(s.created_at).toLocaleDateString()}</span>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm(`Delete "${s.essay_name}" and its grading?`)) return;
                      await api.deleteSession(s.id);
                      qc.invalidateQueries({ queryKey: ["sessions"] });
                    }}
                    className="text-xs text-stone-400 hover:text-red-600"
                    aria-label={`Delete ${s.essay_name}`}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
