import { DocxEditor } from "@docx-editor.dev/react";

/** Read-only rendering of a .docx, for checking the essay before grading. */
export function DocxPreview({ bytes }: { bytes: Uint8Array }) {
  return (
    <DocxEditor.Root document={bytes} author="Essay Grader" mode="view">
      <DocxEditor.Viewport className="h-full">
        <DocxEditor.Content />
      </DocxEditor.Viewport>
    </DocxEditor.Root>
  );
}
