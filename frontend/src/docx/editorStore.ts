import type { Editor } from "@docx-editor.dev/react";
import { create } from "zustand";
import type { BlockRef } from "./bridge";

/** The live editor instance and the paragraph-key → block map (not serializable, so kept apart). */
interface EditorStore {
  editor: Editor | null;
  blocks: Map<string, BlockRef>;
  showScores: boolean;
  /** Comment, grammar and proposal marks stay hidden until the teacher asks for them. */
  showDetails: boolean;
  /** Review panel docked beside the essay. */
  reviewOpen: boolean;
  setEditor: (e: Editor | null) => void;
  setBlocks: (b: Map<string, BlockRef>) => void;
  toggleScores: () => void;
  setShowDetails: (v: boolean) => void;
  setReviewOpen: (v: boolean) => void;
}

export const useEditorStore = create<EditorStore>()((set) => ({
  editor: null,
  blocks: new Map(),
  showScores: true,
  showDetails: false,
  reviewOpen: false,
  setEditor: (editor) => set({ editor }),
  setBlocks: (blocks) => set({ blocks }),
  toggleScores: () => set((s) => ({ showScores: !s.showScores })),
  setShowDetails: (showDetails) => set({ showDetails }),
  setReviewOpen: (reviewOpen) => set({ reviewOpen }),
}));
