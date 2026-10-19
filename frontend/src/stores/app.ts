import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import type { Envelope } from "../api/client";
import type { DecisionResp } from "../api/gen/DecisionResp";
import type { ModelRef } from "../api/gen/ModelRef";
import type { SessionSnapshot } from "../api/gen/SessionSnapshot";
import type { ThinkSetting } from "../api/gen/ThinkSetting";
import { type AppData, applyEvent, emptyData, replay, sessionFromSnapshot } from "./applyEvent";

export type Tab = "essay" | "rubric" | "assessment";

interface AppStore extends AppData {
  tab: Tab;
  /** Paragraph key under focus (clicked in the essay, a comment, or a chat reference). */
  focusPara: string | null;
  focusAnnotation: string | null;
  loadSession: (snap: SessionSnapshot) => void;
  reset: () => void;
  apply: (env: Envelope) => void;
  applyDecision: (resp: DecisionResp) => void;
  echoUser: (text: string) => void;
  setTab: (tab: Tab) => void;
  focus: (para: string | null, annotation?: string | null) => void;
}

export const useApp = create<AppStore>()(
  immer((set) => ({
    ...emptyData(),
    tab: "essay",
    focusPara: null,
    focusAnnotation: null,
    loadSession: (snap) =>
      set((d) => {
        Object.assign(d, emptyData());
        d.session = sessionFromSnapshot(snap);
        replay(d, snap.transcript as unknown as Envelope[]);
        d.activeRunId = snap.active_run;
      }),
    reset: () =>
      set((d) => {
        Object.assign(d, emptyData());
        d.tab = "essay";
        d.focusPara = null;
      }),
    apply: (env) => set((d) => applyEvent(d, env)),
    applyDecision: (resp) =>
      set((d) => {
        if (!d.session) return;
        d.session.proposals = resp.proposals;
        d.session.annotations = resp.annotations;
        d.session.paragraphs = resp.paragraphs;
      }),
    echoUser: (text) =>
      set((d) => {
        d.items.push({ kind: "user", id: `local_${Date.now()}`, text });
      }),
    setTab: (tab) => set({ tab }),
    focus: (para, annotation = null) => set({ focusPara: para, focusAnnotation: annotation }),
  })),
);

/** Model choice + think level, remembered across reloads. */
interface PrefsStore {
  model: ModelRef | null;
  think: ThinkSetting | null;
  setModel: (m: ModelRef) => void;
  setThink: (t: ThinkSetting | null) => void;
}

export const usePrefs = create<PrefsStore>()(
  persist(
    (set) => ({
      model: null,
      think: null,
      setModel: (model) => set({ model }),
      setThink: (think) => set({ think }),
    }),
    { name: "grader-prefs" },
  ),
);
