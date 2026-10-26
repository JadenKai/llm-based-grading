import { EventSourceParserStream } from "eventsource-parser/stream";
import type { Event } from "./gen/Event";
import type { ModelRef } from "./gen/ModelRef";
import type { Paragraph } from "./gen/Paragraph";
import type { SessionSnapshot } from "./gen/SessionSnapshot";
import type { SessionSummary } from "./gen/SessionSummary";
import type { SettingsView } from "./gen/SettingsView";
import type { ProviderModels } from "./gen/ProviderModels";
import type { DecisionReq } from "./gen/DecisionReq";
import type { DecisionResp } from "./gen/DecisionResp";
import type { ThinkSetting } from "./gen/ThinkSetting";
import type { Presets } from "./gen/Presets";

export type Envelope = { seq: number; run_id: string } & Event;

export type Source = File | { preset: string };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  getSettings: () => request<SettingsView>("/api/settings"),
  putSettings: (s: SettingsView) => request<SettingsView>("/api/settings", json("PUT", s)),
  models: () => request<ProviderModels[]>("/api/models"),
  testProvider: (id: string) =>
    request<{ ok: boolean; models?: number; error?: string }>(`/api/providers/${encodeURIComponent(id)}/test`, {
      method: "POST",
    }),

  listSessions: () => request<SessionSummary[]>("/api/sessions"),
  presets: () => request<Presets>("/api/presets"),
  /** Each source is an uploaded file or the id of a bundled example. */
  createSession: (essay: Source, rubric: Source) => {
    const fd = new FormData();
    if (essay instanceof File) fd.append("essay", essay);
    else fd.append("essay_preset", essay.preset);
    if (rubric instanceof File) fd.append("rubric", rubric);
    else fd.append("rubric_preset", rubric.preset);
    return request<{ session_id: string }>("/api/sessions", { method: "POST", body: fd });
  },
  getSession: (id: string) => request<SessionSnapshot>(`/api/sessions/${id}`),
  deleteSession: (id: string) => request<void>(`/api/sessions/${id}`, { method: "DELETE" }),
  docx: async (id: string) => {
    const res = await fetch(`/api/sessions/${id}/docx`);
    if (!res.ok) throw new ApiError(res.status, "could not load the document");
    return new Uint8Array(await res.arrayBuffer());
  },
  putDocx: (id: string, bytes: ArrayBuffer) =>
    request<void>(`/api/sessions/${id}/docx`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    }),
  putParagraphs: (id: string, paragraphs: Paragraph[]) =>
    request<SessionSnapshot>(`/api/sessions/${id}/paragraphs`, json("PUT", { paragraphs })),
  decide: (id: string, pid: string, req: DecisionReq) =>
    request<DecisionResp>(`/api/sessions/${id}/proposals/${pid}`, json("POST", req)),
  cancelRun: (id: string, runId: string) =>
    request<void>(`/api/sessions/${id}/runs/${runId}/cancel`, { method: "POST" }),
};

/** Read an SSE response, calling `onEvent` per envelope until the run finishes or the stream ends. */
async function consume(res: Response, onEvent: (e: Envelope) => void, signal?: AbortSignal) {
  if (!res.ok || !res.body) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  const reader = res.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
    .getReader();
  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      if (!value.data) continue;
      const env = JSON.parse(value.data) as Envelope;
      onEvent(env);
      if (env.type === "run_finished") break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export const streams = {
  grade: async (id: string, paragraphs: Paragraph[], model: ModelRef, onEvent: (e: Envelope) => void) => {
    const res = await fetch(`/api/sessions/${id}/grade`, json("POST", { paragraphs, model }));
    await consume(res, onEvent);
  },
  chat: async (
    id: string,
    message: string,
    model: ModelRef,
    think: ThinkSetting | null,
    onEvent: (e: Envelope) => void,
  ) => {
    const res = await fetch(`/api/sessions/${id}/chat`, json("POST", { message, model, think }));
    await consume(res, onEvent);
  },
  attach: async (id: string, runId: string, onEvent: (e: Envelope) => void) => {
    const res = await fetch(`/api/sessions/${id}/runs/${runId}/events`);
    await consume(res, onEvent);
  },
};
