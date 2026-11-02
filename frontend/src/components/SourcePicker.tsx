import { type ReactNode, useRef, useState } from "react";

/** Pick a bundled example from a dropdown, or drop / browse for a file. */
export function SourcePicker({
  title,
  description,
  placeholder,
  options,
  accept,
  fileLabel,
  onPreset,
  onFile,
  error,
  busy,
  footer,
}: {
  title: string;
  description: string;
  placeholder: string;
  options: { id: string; name: string; detail?: string }[];
  accept: string;
  fileLabel: string;
  onPreset: (id: string) => void;
  onFile: (f: File) => void;
  error?: string | null;
  busy?: boolean;
  footer?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-md space-y-5 px-6 py-12">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-stone-900">{title}</h2>
          <p className="text-sm text-stone-500">{description}</p>
        </div>
        <select
          value=""
          disabled={busy}
          onChange={(e) => e.target.value && onPreset(e.target.value)}
          className="w-full rounded-md border border-stone-300 bg-white px-2.5 py-2 text-sm text-stone-800 outline-none focus:border-stone-500"
          aria-label={placeholder}
        >
          <option value="">{placeholder}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.detail ? ` — ${o.detail}` : ""}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-3 text-xs text-stone-400">
          <span className="h-px flex-1 bg-stone-200" />
          or
          <span className="h-px flex-1 bg-stone-200" />
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => input.current?.click()}
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
          className={`flex h-32 w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-sm transition ${
            over ? "border-stone-500 bg-stone-100 text-stone-700" : "border-stone-300 text-stone-500 hover:bg-stone-50"
          }`}
        >
          <span>{busy ? "Loading…" : `Drop ${fileLabel} here`}</span>
          {!busy && <span className="text-xs text-stone-400">or click to browse</span>}
        </button>
        <input
          ref={input}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        {footer}
      </div>
    </div>
  );
}
