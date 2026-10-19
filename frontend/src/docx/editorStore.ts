import type { Editor } from "@docx-editor.dev/react";
import { create } from "zustand";
import type { BlockRef } from "./bridge";

/** The live editor instance and the paragraph-key → block map (not serializable, so kept apart). */
interface EditorStore {
  editor: Editor | null;
  blocks: Map<string, BlockRef>;
  showScores: boolean;
  setEditor: (e: Editor | null) => void;
  setBlocks: (b: Map<string, BlockRef>) => void;
  toggleScores: () => void;
}

export const useEditorStore = create<EditorStore>()((set) => ({
  editor: null,
  blocks: new Map(),
  showScores: true,
  setEditor: (editor) => set({ editor }),
  setBlocks: (blocks) => set({ blocks }),
  toggleScores: () => set((s) => ({ showScores: !s.showScores })),
}));
