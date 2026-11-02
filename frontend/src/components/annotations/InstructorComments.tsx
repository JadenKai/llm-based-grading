import { useState } from "react";
import { api } from "../../api/client";
import type { Annotation } from "../../api/gen/Annotation";
import { useApp } from "../../stores/app";
import { LocateButton } from "./ProposalCard";

type Comment = Extract<Annotation, { kind: "comment" }>;

async function call(fn: (sessionId: string) => ReturnType<typeof api.addComment>) {
  const s = useApp.getState().session;
  if (!s) throw new Error("No essay is open.");
  useApp.getState().applyDecision(await fn(s.id));
}

export const addInstructorComment = (para: string, text: string, quote?: string) =>
  call((id) => api.addComment(id, { para, text, quote }));

/** Textarea for writing (or editing) an instructor comment. */
export function CommentComposer({
  initial = "",
  quote,
  placeholder = "Add your comment…",
  submitLabel = "Add comment",
  onSubmit,
  onCancel,
  autoFocus = true,
}: {
  initial?: string;
  quote?: string;
  placeholder?: string;
  submitLabel?: string;
  onSubmit: (text: string) => Promise<void>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text.trim());
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5">
      {quote && <blockquote className="border-l-2 border-stone-300 pl-2 text-xs italic text-stone-500">“{quote}”</blockquote>}
      <textarea
        autoFocus={autoFocus}
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          if (e.key === "Escape") onCancel?.();
        }}
        placeholder={placeholder}
        className="block w-full resize-y rounded-md border border-stone-300 px-2 py-1.5 text-sm outline-none focus:border-stone-500"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={submit}
          className="rounded-md bg-stone-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-stone-700 disabled:bg-stone-300"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-xs text-stone-500 hover:text-stone-900">
            Cancel
          </button>
        )}
        <span className="ml-auto text-[10px] text-stone-400">Ctrl+Enter</span>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

/** The teacher's own comment: set apart from the model's (dark rule, "Instructor" label), editable. */
export function InstructorCommentCard({ a, locate = true }: { a: Comment; locate?: boolean }) {
  const focused = useApp((s) => s.focusAnnotation === a.id);
  const [editing, setEditing] = useState(false);
  return (
    <div
      className={`rounded-lg border-l-[3px] border-stone-900 bg-white p-2.5 ring-1 ${
        focused ? "ring-2 ring-amber-300" : "ring-stone-200"
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px]">
        <span className="font-semibold text-stone-900">Instructor</span>
        <span className="font-mono text-stone-500">{a.para}</span>
        {locate && (
          <>
            <span className="text-stone-300">·</span>
            <LocateButton para={a.para} annId={a.id} />
          </>
        )}
        {!editing && (
          <span className="ml-auto flex gap-2 text-stone-400">
            <button type="button" className="hover:text-stone-900" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              className="hover:text-red-600"
              onClick={() => confirm("Delete this comment?") && call((id) => api.deleteComment(id, a.id))}
            >
              Delete
            </button>
          </span>
        )}
      </div>
      {a.anchor && !editing && (
        <blockquote className="mb-1 border-l-2 border-stone-200 pl-2 text-xs italic text-stone-500">“{a.anchor.quote}”</blockquote>
      )}
      {editing ? (
        <CommentComposer
          initial={a.text}
          submitLabel="Save"
          onSubmit={async (text) => {
            await call((id) => api.editComment(id, a.id, text));
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <p className="text-sm whitespace-pre-wrap text-stone-900">{a.text}</p>
      )}
    </div>
  );
}

/** "Add comment" link that opens a composer for a whole paragraph. */
export function AddCommentLink({ para }: { para: string }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs text-stone-500 hover:text-stone-900">
        + Add instructor comment
      </button>
    );
  return (
    <CommentComposer
      placeholder={`Comment on ${para}…`}
      onSubmit={async (text) => {
        await addInstructorComment(para, text);
        setOpen(false);
      }}
      onCancel={() => setOpen(false)}
    />
  );
}
