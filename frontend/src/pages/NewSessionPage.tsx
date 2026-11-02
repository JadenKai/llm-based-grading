import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type Source } from "../api/client";
import type { Rubric } from "../api/gen/Rubric";
import { Pane, Workspace } from "../components/layout/Workspace";
import { ModelPicker } from "../components/ModelPicker";
import { RubricDetails } from "../components/RubricView";
import { SourcePicker } from "../components/SourcePicker";
import { DocxPreview } from "../docx/DocxPreview";
import { type RightTab, usePrefs } from "../stores/app";

interface EssayPick {
  source: Source;
  name: string;
  bytes: Uint8Array;
}

interface RubricPick {
  source: Source;
  rubric: Rubric;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A strip above a preview: what it is, and a way to pick something else. */
function PreviewBar({ label, name, onChange }: { label: string; name: string; onChange: () => void }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-stone-200 bg-stone-50 px-3 text-xs">
      <span className="text-stone-500">{label}</span>
      <span className="truncate font-medium text-stone-800">{name}</span>
      <button type="button" onClick={onChange} className="ml-auto text-stone-500 hover:text-stone-900">
        Change
      </button>
    </div>
  );
}

function Recent() {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.listSessions });
  if (!sessions.data?.length) return null;
  return (
    <section className="space-y-2 pt-6">
      <h3 className="text-xs font-medium text-stone-500">Recent</h3>
      <ul className="divide-y divide-stone-100 rounded-lg ring-1 ring-stone-200">
        {sessions.data.slice(0, 8).map((s) => (
          <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <Link to={`/grade/${s.id}`} className="flex-1 truncate text-stone-800 hover:underline">
              {s.essay_name}
            </Link>
            <span className="text-xs tabular-nums text-stone-500">
              {s.graded && s.overall != null ? `${fmt(s.overall)} / ${fmt(s.max ?? 0)}` : "not graded"}
            </span>
            <button
              type="button"
              onClick={async () => {
                if (!confirm(`Delete "${s.essay_name}" and its grading?`)) return;
                await api.deleteSession(s.id);
                qc.invalidateQueries({ queryKey: ["sessions"] });
              }}
              className="text-xs text-stone-400 hover:text-red-600"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Start screen, laid out like the grading workspace: choose the essay on the left and the
 * rubric in the chat window, check both previews, then start grading.
 */
export function NewSessionPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const model = usePrefs((s) => s.model);
  const presets = useQuery({ queryKey: ["presets"], queryFn: api.presets, staleTime: Infinity });
  const [essay, setEssay] = useState<EssayPick | null>(null);
  const [rubric, setRubric] = useState<RubricPick | null>(null);
  const [essayBusy, setEssayBusy] = useState(false);
  const [rubricBusy, setRubricBusy] = useState(false);
  const [essayError, setEssayError] = useState<string | null>(null);
  const [rubricError, setRubricError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("chat");

  const pickEssay = async (load: () => Promise<EssayPick>) => {
    setEssayBusy(true);
    setEssayError(null);
    try {
      setEssay(await load());
    } catch (e) {
      setEssayError(errText(e));
    } finally {
      setEssayBusy(false);
    }
  };
  const pickRubric = async (load: () => Promise<RubricPick>) => {
    setRubricBusy(true);
    setRubricError(null);
    try {
      setRubric(await load());
    } catch (e) {
      setRubricError(errText(e));
    } finally {
      setRubricBusy(false);
    }
  };

  const start = async () => {
    if (!essay || !rubric) return;
    setStarting(true);
    setStartError(null);
    try {
      const { session_id } = await api.createSession(essay.source, rubric.source);
      qc.invalidateQueries({ queryKey: ["sessions"] });
      navigate(`/grade/${session_id}`);
    } catch (e) {
      setStartError(errText(e));
      setStarting(false);
    }
  };

  const rubricPicker = (
    <SourcePicker
      title="Rubric"
      description="Choose an example rubric or upload your own JSON rubric."
      placeholder="Choose an example rubric…"
      options={(presets.data?.rubrics ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        detail: `${r.criteria} criteria, ${fmt(r.total_points)} pts`,
      }))}
      accept=".json,application/json"
      fileLabel="a .json rubric"
      busy={rubricBusy}
      error={rubricError}
      onPreset={(id) => pickRubric(async () => ({ source: { preset: id }, rubric: await api.presetRubric(id) }))}
      onFile={(f) =>
        f.name.toLowerCase().endsWith(".json")
          ? pickRubric(async () => ({ source: f, rubric: await api.parseRubric(f) }))
          : setRubricError("The rubric must be a .json file.")
      }
      footer={
        <p className="text-xs text-stone-400">
          Format: <code>{'{"title": …, "criteria": [{"name": …, "points": …}]}'}</code>
        </p>
      }
    />
  );

  const ready = !!essay && !!rubric && !!model;

  return (
    <Workspace
      title={essay ? essay.name.replace(/\.docx$/i, "") : <span className="text-stone-400">New essay</span>}
      leftTabs={[
        { id: "essay", label: "Essay" },
        { id: "review", label: "Review", disabled: true },
      ]}
      leftTab="essay"
      onLeftTab={() => {}}
      rightTabs={[
        { id: "chat", label: "Chat" },
        { id: "rubric", label: "Rubric" },
        { id: "assessment", label: "Original Assessment", disabled: true },
      ]}
      rightTab={rightTab}
      onRightTab={setRightTab}
      forceRight
      menu={[{ label: "Settings", to: "/settings" }]}
      left={
        essay ? (
          <div className="absolute inset-0 flex flex-col">
            <PreviewBar label="Essay" name={essay.name} onChange={() => setEssay(null)} />
            <div className="min-h-0 flex-1">
              <DocxPreview key={essay.name} bytes={essay.bytes} />
            </div>
          </div>
        ) : (
          <SourcePicker
            title="Essay"
            description="Choose an example essay or upload a student's .docx."
            placeholder="Choose an example essay…"
            options={(presets.data?.essays ?? []).map((e) => ({ id: e.id, name: e.name }))}
            accept=".docx"
            fileLabel="a .docx essay"
            busy={essayBusy}
            error={essayError}
            onPreset={(id) =>
              pickEssay(async () => ({
                source: { preset: id },
                name: presets.data?.essays.find((e) => e.id === id)?.name ?? id,
                bytes: await api.presetEssay(id),
              }))
            }
            onFile={(f) =>
              f.name.toLowerCase().endsWith(".docx")
                ? pickEssay(async () => ({ source: f, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))
                : setEssayError("The essay must be a .docx file.")
            }
            footer={<Recent />}
          />
        )
      }
      right={
        <>
          <Pane shown={rightTab === "chat"}>
            <div className="min-h-0 flex-1">
              {rubric ? (
                <div className="flex h-full flex-col">
                  <PreviewBar label="Rubric" name={rubric.rubric.title} onChange={() => setRubric(null)} />
                  <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
                    <RubricDetails rubric={rubric.rubric} />
                  </div>
                </div>
              ) : (
                rubricPicker
              )}
            </div>
            <div className="shrink-0 space-y-2 border-t border-stone-200 p-3">
              <ul className="space-y-0.5 text-xs">
                <li className={essay ? "text-stone-700" : "text-stone-400"}>
                  {essay ? "✓" : "○"} Essay{essay ? `: ${essay.name}` : " — choose one on the left"}
                </li>
                <li className={rubric ? "text-stone-700" : "text-stone-400"}>
                  {rubric ? "✓" : "○"} Rubric{rubric ? `: ${rubric.rubric.title}` : " — choose one above"}
                </li>
              </ul>
              {essay && rubric && (
                <p className="text-xs text-stone-500">Check both previews, then start grading.</p>
              )}
              <div className="flex items-center justify-between gap-2">
                <ModelPicker />
                <button
                  type="button"
                  disabled={!ready || starting}
                  onClick={start}
                  className="rounded-md bg-stone-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-700 disabled:bg-stone-300"
                >
                  {starting ? "Starting…" : "Start grading"}
                </button>
              </div>
              {startError && <p className="text-xs text-red-600">{startError}</p>}
            </div>
          </Pane>
          {rightTab === "rubric" && (
            <div className="absolute inset-0 overflow-y-auto px-6 py-6">
              {rubric ? (
                <RubricDetails rubric={rubric.rubric} />
              ) : (
                <p className="text-sm text-stone-400">Choose a rubric in the Chat tab.</p>
              )}
            </div>
          )}
        </>
      }
    />
  );
}
