import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client";
import type { ModelParams } from "../api/gen/ModelParams";
import type { SettingsView } from "../api/gen/SettingsView";
import type { ThinkSetting } from "../api/gen/ThinkSetting";
import { useModels } from "../components/ModelPicker";

const input =
  "w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-stone-500 disabled:bg-stone-50";

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl bg-white p-5 ring-1 ring-stone-200">
      <h2 className="text-base font-semibold text-stone-900">{title}</h2>
      {description && <p className="mt-0.5 text-sm text-stone-500">{description}</p>}
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-stone-600">{label}</span>
      {children}
      {hint && <span className="block text-xs text-stone-400">{hint}</span>}
    </label>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-stone-700">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-stone-800" />
      {label}
    </label>
  );
}

function TestButton({ providerId }: { providerId: string }) {
  const [state, setState] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={async () => {
          setState("Testing…");
          const r = await api.testProvider(providerId).catch((e) => ({ ok: false, error: String(e.message ?? e) }));
          setState(r.ok ? `✓ Connected — ${"models" in r ? r.models : 0} models` : `✕ ${r.error}`);
        }}
        className="rounded-md px-2.5 py-1 text-xs text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50"
      >
        Test connection
      </button>
      {state && <span className={`text-xs ${state.startsWith("✓") ? "text-emerald-700" : "text-stone-500"}`}>{state}</span>}
    </span>
  );
}

const num = (v: string, int = false): number | null => {
  if (v.trim() === "") return null;
  const n = int ? parseInt(v, 10) : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

function ParamsEditor({ value, onChange, placeholders }: { value: ModelParams; onChange: (p: ModelParams) => void; placeholders?: ModelParams }) {
  const set = <K extends keyof ModelParams>(k: K, v: ModelParams[K]) => onChange({ ...value, [k]: v });
  const ph = (k: keyof ModelParams) => (placeholders?.[k] != null ? String(placeholders[k]) : "model default");
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Field label="Temperature">
        <input className={input} type="number" step="0.05" min="0" max="2" placeholder={ph("temperature")} value={value.temperature ?? ""} onChange={(e) => set("temperature", num(e.target.value))} />
      </Field>
      <Field label="Top P">
        <input className={input} type="number" step="0.05" min="0" max="1" placeholder={ph("top_p")} value={value.top_p ?? ""} onChange={(e) => set("top_p", num(e.target.value))} />
      </Field>
      <Field label="Top K">
        <input className={input} type="number" step="1" min="0" placeholder={ph("top_k")} value={value.top_k ?? ""} onChange={(e) => set("top_k", num(e.target.value, true))} />
      </Field>
      <Field label="Context window (num_ctx)">
        <input className={input} type="number" step="1024" min="512" placeholder={ph("num_ctx")} value={value.num_ctx ?? ""} onChange={(e) => set("num_ctx", num(e.target.value, true))} />
      </Field>
      <Field label="Max output tokens">
        <input className={input} type="number" step="256" min="1" placeholder={ph("max_tokens")} value={value.max_tokens ?? ""} onChange={(e) => set("max_tokens", num(e.target.value, true))} />
      </Field>
      <Field label="Seed">
        <input className={input} type="number" step="1" placeholder={ph("seed")} value={value.seed ?? ""} onChange={(e) => set("seed", num(e.target.value, true))} />
      </Field>
      <Field label="Thinking">
        <select className={input} value={value.think ?? ""} onChange={(e) => set("think", (e.target.value || null) as ThinkSetting | null)}>
          <option value="">{placeholders?.think ? `inherit (${placeholders.think})` : "unset"}</option>
          <option value="default">model default</option>
          <option value="off">off</option>
          <option value="on">on</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </Field>
    </div>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  const models = useModels();
  const [draft, setDraft] = useState<SettingsView | null>(null);
  const [cloudKey, setCloudKey] = useState("");
  const [oaiKeys, setOaiKeys] = useState<Record<string, string>>({});
  const [overrideTarget, setOverrideTarget] = useState("");

  useEffect(() => {
    if (settings.data && !draft) setDraft(structuredClone(settings.data));
  }, [settings.data, draft]);

  // Typed keys and edited fields are only kept once saved; track that so they are never lost silently.
  const dirty =
    !!draft &&
    (cloudKey.trim() !== "" ||
      Object.values(oaiKeys).some((k) => k !== "") ||
      JSON.stringify(draft) !== JSON.stringify(settings.data));
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const confirmLeave = () => !dirty || window.confirm("You have unsaved settings. Leave without saving?");

  const save = useMutation({
    mutationFn: (v: SettingsView) => api.putSettings(v),
    onSuccess: (v) => {
      qc.setQueryData(["settings"], v);
      qc.invalidateQueries({ queryKey: ["models"] });
      setDraft(structuredClone(v));
      setCloudKey("");
      setOaiKeys({});
    },
  });

  if (!draft) return <div className="p-8 text-sm text-stone-500">{settings.error ? String(settings.error) : "Loading settings…"}</div>;
  const up = (f: (d: SettingsView) => void) =>
    setDraft((d) => {
      const n = structuredClone(d!);
      f(n);
      return n;
    });

  const buildPayload = (clearCloudKey = false): SettingsView => {
    const p = structuredClone(draft);
    p.ollama_cloud.api_key = clearCloudKey ? "" : cloudKey.trim() ? cloudKey.trim() : null;
    p.openai_compat = p.openai_compat.map((e) => ({ ...e, api_key: oaiKeys[e.id] !== undefined ? oaiKeys[e.id] : null }));
    return p;
  };

  const allModels = (models.data ?? []).flatMap((p) => p.models.map((m) => ({ provider_id: p.provider_id, label: p.label, model: m.id })));
  const ks = draft.ollama_cloud.key_status;
  const cloud = models.data?.find((p) => p.provider_id === "ollama-cloud");

  return (
    <div className="min-h-screen bg-stone-100">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-stone-200 bg-white/90 px-6 py-3 backdrop-blur">
        <button
          type="button"
          onClick={() => confirmLeave() && navigate(-1)}
          className="text-sm text-stone-600 hover:text-stone-900"
        >
          ← Back
        </button>
        <h1 className="font-semibold text-stone-900">Settings</h1>
        <div className="ml-auto flex items-center gap-3">
          {save.isError && <span className="text-sm text-red-600">{String(save.error.message)}</span>}
          {dirty ? (
            <span className="text-sm text-amber-700">Unsaved changes</span>
          ) : (
            save.isSuccess && !save.isPending && <span className="text-sm text-emerald-700">Saved</span>
          )}
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate(buildPayload())}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${
              dirty ? "bg-amber-600 hover:bg-amber-700" : "bg-stone-900 hover:bg-stone-700"
            }`}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-5 px-6 py-6">
        <Section title="Ollama (local)" description="Models served by an Ollama daemon on this machine or your network.">
          <Toggle checked={draft.ollama_local.enabled} onChange={(v) => up((d) => void (d.ollama_local.enabled = v))} label="Enabled" />
          <Field label="Base URL">
            <input className={input} value={draft.ollama_local.base_url} onChange={(e) => up((d) => void (d.ollama_local.base_url = e.target.value))} />
          </Field>
          <TestButton providerId="ollama-local" />
        </Section>

        <Section
          title="Ollama Cloud — large models"
          description={
            <>
              Run large open models (e.g. <code>gpt-oss:120b</code>) on Ollama's hosted service. Models appear in the
              picker once a key is saved. The key also enables{" "}
              <strong>web search fact-checking</strong>. Create a key at{" "}
              <a className="text-blue-700 underline" href="https://ollama.com/settings/keys" target="_blank" rel="noreferrer">
                ollama.com/settings/keys
              </a>
              .
            </>
          }
        >
          <Toggle checked={draft.ollama_cloud.enabled} onChange={(v) => up((d) => void (d.ollama_cloud.enabled = v))} label="Enabled" />
          <Field
            label="API key"
            hint={
              ks.from_env
                ? `Using OLLAMA_API_KEY from the backend environment (${ks.hint}).`
                : ks.has_key
                  ? `A key is stored (${ks.hint}). Enter a new one to replace it.`
                  : "Stored on the backend only (settings file, mode 0600); never sent back to the browser."
            }
          >
            <div className="flex gap-2">
              <input
                className={input}
                type="password"
                autoComplete="off"
                placeholder={ks.has_key ? "••••••••••••" : "Paste your Ollama API key"}
                value={cloudKey}
                disabled={ks.from_env}
                onChange={(e) => setCloudKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && cloudKey.trim() && save.mutate(buildPayload())}
              />
              {cloudKey.trim() && (
                <button
                  type="button"
                  disabled={save.isPending}
                  onClick={() => save.mutate(buildPayload())}
                  className="shrink-0 rounded-md bg-stone-900 px-3 text-xs font-medium text-white hover:bg-stone-700 disabled:opacity-50"
                >
                  {save.isPending ? "Saving…" : "Save key"}
                </button>
              )}
              {ks.has_key && !ks.from_env && !cloudKey.trim() && (
                <button
                  type="button"
                  onClick={() => save.mutate(buildPayload(true))}
                  className="shrink-0 rounded-md px-2.5 text-xs text-red-600 ring-1 ring-red-200 hover:bg-red-50"
                >
                  Remove key
                </button>
              )}
            </div>
          </Field>
          <Field label="Base URL">
            <input className={input} value={draft.ollama_cloud.base_url} onChange={(e) => up((d) => void (d.ollama_cloud.base_url = e.target.value))} />
          </Field>
          {ks.has_key && draft.ollama_cloud.enabled && (
            <p
              className={`text-sm ${
                !cloud || models.isFetching ? "text-stone-500" : cloud.error ? "text-red-600" : "text-emerald-700"
              }`}
            >
              {!cloud || models.isFetching
                ? "Checking cloud models…"
                : cloud.error
                  ? `Ollama Cloud: ${cloud.error}`
                  : `✓ ${cloud.models.length} cloud models available in the model picker.`}
            </p>
          )}
          {ks.has_key && <TestButton providerId="ollama-cloud" />}
        </Section>

        <Section
          title="OpenAI-compatible endpoints"
          description="vLLM, llama.cpp server, LM Studio, OpenRouter, or any server exposing /v1/chat/completions."
        >
          {draft.openai_compat.map((e, i) => (
            <div key={e.id} className="space-y-2 rounded-xl border border-stone-200 p-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name">
                  <input className={input} value={e.label} onChange={(ev) => up((d) => void (d.openai_compat[i].label = ev.target.value))} />
                </Field>
                <Field label="Base URL (including /v1)">
                  <input className={input} placeholder="http://localhost:8000/v1" value={e.base_url} onChange={(ev) => up((d) => void (d.openai_compat[i].base_url = ev.target.value))} />
                </Field>
              </div>
              <Field label="API key (optional)" hint={e.key_status.has_key ? `Stored (${e.key_status.hint}). Leave blank to keep.` : undefined}>
                <input className={input} type="password" autoComplete="off" value={oaiKeys[e.id] ?? ""} onChange={(ev) => setOaiKeys((k) => ({ ...k, [e.id]: ev.target.value }))} />
              </Field>
              <div className="flex items-center gap-3">
                <Toggle checked={e.enabled} onChange={(v) => up((d) => void (d.openai_compat[i].enabled = v))} label="Enabled" />
                <TestButton providerId={e.id} />
                <button type="button" onClick={() => up((d) => void d.openai_compat.splice(i, 1))} className="ml-auto text-xs text-red-600 hover:underline">
                  Remove
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              up((d) =>
                void d.openai_compat.push({
                  id: `oai-${Math.random().toString(36).slice(2, 8)}`,
                  label: "My server",
                  base_url: "http://localhost:8000/v1",
                  enabled: true,
                  api_key: null,
                  key_status: { has_key: false, hint: null, from_env: false },
                }),
              )
            }
            className="rounded-md px-3 py-1.5 text-sm text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50"
          >
            + Add endpoint
          </button>
          <p className="text-xs text-stone-400">Save, then test the connection.</p>
        </Section>

        <Section title="Model settings" description="Defaults for every model. Per-model overrides below take precedence.">
          <Field label="Default model">
            <select
              className={input}
              value={draft.default_model ? `${draft.default_model.provider_id}\u0000${draft.default_model.model}` : ""}
              onChange={(e) =>
                up((d) => {
                  const [provider_id, model] = e.target.value.split("\u0000");
                  d.default_model = e.target.value ? { provider_id, model } : null;
                })
              }
            >
              <option value="">First available</option>
              {allModels.map((m) => (
                <option key={`${m.provider_id}/${m.model}`} value={`${m.provider_id}\u0000${m.model}`}>
                  {m.label} — {m.model}
                </option>
              ))}
            </select>
          </Field>
          <ParamsEditor value={draft.defaults} onChange={(p) => up((d) => void (d.defaults = p))} />
          <Field label="Max agent steps per chat turn">
            <input className={`${input} w-32`} type="number" min={1} max={50} value={draft.max_agent_iterations} onChange={(e) => up((d) => void (d.max_agent_iterations = num(e.target.value, true) ?? 12))} />
          </Field>
        </Section>

        <Section title="Per-model overrides" description="Different models need different settings — e.g. a larger context window for big cloud models.">
          {draft.overrides.map((o, i) => (
            <div key={`${o.provider_id}/${o.model}`} className="space-y-2 rounded-xl border border-stone-200 p-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-mono font-medium text-stone-800">{o.model}</span>
                <span className="text-xs text-stone-400">{o.provider_id}</span>
                <button type="button" onClick={() => up((d) => void d.overrides.splice(i, 1))} className="ml-auto text-xs text-red-600 hover:underline">
                  Remove
                </button>
              </div>
              <ParamsEditor value={o.params} placeholders={draft.defaults} onChange={(p) => up((d) => void (d.overrides[i].params = p))} />
            </div>
          ))}
          <div className="flex gap-2">
            <select className={input} value={overrideTarget} onChange={(e) => setOverrideTarget(e.target.value)}>
              <option value="">Choose a model…</option>
              {allModels
                .filter((m) => !draft.overrides.some((o) => o.provider_id === m.provider_id && o.model === m.model))
                .map((m) => (
                  <option key={`${m.provider_id}/${m.model}`} value={`${m.provider_id}\u0000${m.model}`}>
                    {m.label} — {m.model}
                  </option>
                ))}
            </select>
            <button
              type="button"
              disabled={!overrideTarget}
              onClick={() => {
                const [provider_id, model] = overrideTarget.split("\u0000");
                up((d) =>
                  void d.overrides.push({
                    provider_id,
                    model,
                    params: { temperature: null, top_p: null, top_k: null, num_ctx: null, max_tokens: null, seed: null, think: null },
                  }),
                );
                setOverrideTarget("");
              }}
              className="shrink-0 rounded-md px-3 text-sm text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50 disabled:opacity-50"
            >
              + Add override
            </button>
          </div>
        </Section>

        <Section title="Grading">
          <div className="flex flex-wrap gap-5">
            <Toggle checked={draft.grading.fact_check} onChange={(v) => up((d) => void (d.grading.fact_check = v))} label="Fact-check claims with web search (needs Ollama key)" />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Max claims to fact-check">
              <input className={input} type="number" min={0} max={10} value={draft.grading.max_fact_checks} onChange={(e) => up((d) => void (d.grading.max_fact_checks = num(e.target.value, true) ?? 0))} />
            </Field>
            <Field label="Max grammar issues / paragraph">
              <input className={input} type="number" min={0} max={50} value={draft.grading.max_lints_per_paragraph} onChange={(e) => up((d) => void (d.grading.max_lints_per_paragraph = num(e.target.value, true) ?? 0))} />
            </Field>
            <Field label="English dialect">
              <select className={input} value={draft.grading.dialect} onChange={(e) => up((d) => void (d.grading.dialect = e.target.value))}>
                {["American", "British", "Canadian", "Australian", "Indian"].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </Field>
            <Field label="Parallel requests (local)">
              <input className={input} type="number" min={1} max={16} value={draft.grading.concurrency_local} onChange={(e) => up((d) => void (d.grading.concurrency_local = num(e.target.value, true) ?? 1))} />
            </Field>
            <Field label="Parallel requests (cloud/remote)">
              <input className={input} type="number" min={1} max={16} value={draft.grading.concurrency_remote} onChange={(e) => up((d) => void (d.grading.concurrency_remote = num(e.target.value, true) ?? 1))} />
            </Field>
          </div>
          <Field label="Ignored grammar rule kinds" hint="Comma-separated Harper lint kinds, e.g. Spelling, Style, Readability">
            <input
              className={input}
              value={draft.grading.disabled_lint_kinds.join(", ")}
              onChange={(e) => up((d) => void (d.grading.disabled_lint_kinds = e.target.value.split(",").map((s) => s.trim()).filter(Boolean)))}
            />
          </Field>
        </Section>

        <Section title="Chat instructions" description="Extra instructions appended to the agent's system prompt (e.g. grade level, tone).">
          <textarea
            className={`${input} min-h-28`}
            placeholder="e.g. These are 10th-grade essays. Be encouraging but specific."
            value={draft.system_prompt ?? ""}
            onChange={(e) => up((d) => void (d.system_prompt = e.target.value || null))}
          />
        </Section>
        <p className="pb-8 text-center text-xs text-stone-400">
          <Link to="/" className="hover:underline" onClick={(e) => !confirmLeave() && e.preventDefault()}>
            Back to upload
          </Link>
        </p>
      </main>
    </div>
  );
}
