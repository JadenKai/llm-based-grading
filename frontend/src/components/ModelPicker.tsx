import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import type { ModelRef } from "../api/gen/ModelRef";
import type { ProviderModels } from "../api/gen/ProviderModels";
import { usePrefs } from "../stores/app";

export function useModels() {
  return useQuery({ queryKey: ["models"], queryFn: api.models, staleTime: 60_000 });
}

const KIND_ICON: Record<ProviderModels["kind"], string> = {
  ollama_local: "💻",
  ollama_cloud: "☁️",
  openai_compat: "🔌",
};

/** Pick a sensible model when none is chosen or the chosen one disappeared. */
export function useEnsureModel() {
  const { data } = useModels();
  const { model, setModel } = usePrefs();
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
  useEffect(() => {
    if (!data) return;
    const exists = (m: ModelRef | null) =>
      !!m && data.some((p) => p.provider_id === m.provider_id && p.models.some((x) => x.id === m.model));
    if (exists(model)) return;
    const preferred = settings?.default_model ?? null;
    if (exists(preferred)) return setModel(preferred!);
    const first = data.find((p) => p.models.length);
    if (first) setModel({ provider_id: first.provider_id, model: first.models[0].id });
  }, [data, model, settings, setModel]);
  return model;
}

export function ModelPicker({ direction = "up" }: { direction?: "up" | "down" }) {
  const { data, isLoading, refetch, isFetching } = useModels();
  const model = useEnsureModel();
  const setModel = usePrefs((s) => s.setModel);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const groups = useMemo(
    () =>
      (data ?? []).map((p) => ({
        ...p,
        models: p.models.filter((m) => m.id.toLowerCase().includes(q.toLowerCase())),
      })),
    [data, q],
  );
  const current = data?.find((p) => p.provider_id === model?.provider_id);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-64 items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-stone-700 hover:bg-stone-100"
        title="Choose model"
      >
        {current && <span>{KIND_ICON[current.kind]}</span>}
        <span className="truncate font-medium">{model?.model ?? (isLoading ? "Loading models…" : "Choose a model")}</span>
        <span className="text-stone-400">▾</span>
      </button>
      {open && (
        <div
          className={`absolute z-50 w-80 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xl ${
            direction === "up" ? "bottom-full mb-2" : "top-full mt-2"
          } left-0`}
        >
          <div className="flex items-center gap-2 border-b border-stone-100 p-2">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search models"
              className="w-full rounded-md bg-stone-50 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-stone-300"
            />
            <button
              type="button"
              onClick={() => refetch()}
              className="text-xs text-stone-500 hover:text-stone-800"
              title="Refresh model list"
            >
              {isFetching ? "…" : "↻"}
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {groups.map((p) => (
              <div key={p.provider_id} className="py-1">
                <div className="flex items-center gap-1 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
                  <span>{KIND_ICON[p.kind]}</span> {p.label}
                </div>
                {p.error && (
                  <div className="px-3 pb-1 text-xs text-stone-500">
                    {p.error}
                    {p.kind !== "ollama_local" && (
                      <>
                        {" "}
                        <Link to="/settings" className="text-blue-700 underline">
                          Open Settings
                        </Link>
                      </>
                    )}
                  </div>
                )}
                {!p.error && p.models.length === 0 && <div className="px-3 pb-1 text-xs text-stone-400">No models</div>}
                {p.models.map((m) => {
                  const active = model?.provider_id === p.provider_id && model.model === m.id;
                  return (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => {
                        setModel({ provider_id: p.provider_id, model: m.id });
                        setOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-stone-50 ${
                        active ? "bg-stone-100" : ""
                      }`}
                    >
                      <span className="w-3 text-stone-700">{active ? "✓" : ""}</span>
                      <span className="flex-1 truncate">{m.id}</span>
                      {m.size && <span className="text-[10px] text-stone-400">{m.size}</span>}
                      {m.caps.includes("tools") && (
                        <span className="rounded bg-sky-50 px-1 text-[10px] text-sky-700" title="Supports tool calling">
                          tools
                        </span>
                      )}
                      {m.caps.includes("thinking") && (
                        <span className="rounded bg-violet-50 px-1 text-[10px] text-violet-700" title="Supports thinking">
                          think
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            {!isLoading && !data?.length && (
              <div className="px-3 py-2 text-sm text-stone-500">No providers configured.</div>
            )}
          </div>
          <Link
            to="/settings"
            className="block border-t border-stone-100 px-3 py-2 text-xs text-stone-500 hover:bg-stone-50 hover:text-stone-800"
          >
            Manage providers & model settings →
          </Link>
        </div>
      )}
    </div>
  );
}
