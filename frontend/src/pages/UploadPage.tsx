import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client";
import { ModelPicker } from "../components/ModelPicker";
import { usePrefs } from "../stores/app";

function DropZone({
  label,
  hint,
  accept,
  file,
  onFile,
}: {
  label: string;
  hint: string;
  accept: string;
  file: File | null;
  onFile: (f: File) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
      className={`flex h-40 cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed p-4 text-center transition ${
        over ? "border-stone-500 bg-stone-100" : file ? "border-emerald-400 bg-emerald-50/40" : "border-stone-300 bg-white hover:bg-stone-50"
      }`}
    >
      <input type="file" accept={accept} className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      <span className="text-sm font-medium text-stone-800">{label}</span>
      {file ? (
        <span className="text-sm text-emerald-700">✓ {file.name}</span>
      ) : (
        <span className="text-xs text-stone-500">{hint}</span>
      )}
    </label>
  );
}

export function UploadPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [essay, setEssay] = useState<File | null>(null);
  const [rubric, setRubric] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = usePrefs((s) => s.model);
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.listSessions });

  const pickEssay = (f: File) => {
    if (!f.name.toLowerCase().endsWith(".docx")) return setError("The essay must be a .docx file.");
    setError(null);
    setEssay(f);
  };
  const pickRubric = (f: File) => {
    if (!/\.(md|markdown|txt)$/i.test(f.name)) return setError("The rubric must be a Markdown (.md) file.");
    setError(null);
    setRubric(f);
  };

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

  return (
    <div className="min-h-screen bg-stone-100">
      <header className="flex items-center justify-between px-6 py-4">
        <span className="font-semibold text-stone-800">✎ Essay Grader</span>
        <Link to="/settings" className="text-sm text-stone-600 hover:text-stone-900">
          ⚙ Settings
        </Link>
      </header>
      <main className="mx-auto max-w-2xl space-y-6 px-6 pt-10 pb-16">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold text-stone-900">Grade an essay</h1>
          <p className="text-sm text-stone-500">
            Upload the student's essay and your rubric. The agent highlights each paragraph, checks grammar and facts,
            and scores the essay against the rubric. Then you can discuss the grade with it.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <DropZone label="Essay" hint="Drop a .docx file or click to browse" accept=".docx" file={essay} onFile={pickEssay} />
          <DropZone label="Rubric" hint="Drop a Markdown (.md) file" accept=".md,.markdown,.txt" file={rubric} onFile={pickRubric} />
        </div>
        <div className="flex items-center justify-between rounded-2xl bg-white p-3 ring-1 ring-stone-200">
          <div className="flex items-center gap-2 text-sm text-stone-500">
            Grading model
            <ModelPicker direction="down" />
          </div>
          <button
            type="button"
            disabled={!essay || !rubric || !model || busy}
            onClick={submit}
            className="rounded-xl bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700 disabled:bg-stone-300"
          >
            {busy ? "Uploading…" : "Grade essay"}
          </button>
        </div>
        {error && <p className="text-center text-sm text-red-600">{error}</p>}

        {!!sessions.data?.length && (
          <section className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Recent</h2>
            <ul className="divide-y divide-stone-100 overflow-hidden rounded-2xl bg-white ring-1 ring-stone-200">
              {sessions.data.slice(0, 12).map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <Link to={`/grade/${s.id}`} className="flex-1 truncate text-stone-800 hover:underline">
                    {s.essay_name}
                  </Link>
                  <span className="text-xs text-stone-500">
                    {s.graded && s.overall != null ? `${s.overall} / ${s.max}` : "not graded"}
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
                    title="Delete"
                  >
                    ✕
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
