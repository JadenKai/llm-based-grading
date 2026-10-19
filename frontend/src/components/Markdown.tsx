import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useApp } from "../stores/app";

/** Turn paragraph references like [P3] into clickable chips. */
function linkParagraphs(md: string) {
  return md.replace(/\[(P\d+)\](?!\()/g, "[$1](#para-$1)");
}

export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  const focus = useApp((s) => s.focus);
  const setTab = useApp((s) => s.setTab);
  return (
    <div className={`prose-sm markdown ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith("#para-")) {
              const key = href.slice(6);
              return (
                <button
                  type="button"
                  className="mx-0.5 rounded bg-stone-200 px-1 font-mono text-[0.8em] text-stone-700 hover:bg-amber-200"
                  onClick={() => {
                    setTab("essay");
                    focus(key);
                  }}
                >
                  {children}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" className="text-blue-700 underline">
                {children}
              </a>
            );
          },
        }}
      >
        {linkParagraphs(children)}
      </ReactMarkdown>
    </div>
  );
}
