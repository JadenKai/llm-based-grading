import { type ReactNode, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Link } from "react-router";
import { usePrefs } from "../../stores/app";

export interface TabDef<T extends string> {
  id: T;
  label: string;
  badge?: number;
  disabled?: boolean;
}

function TabBar<T extends string>({
  tabs,
  active,
  onSelect,
  center,
  right,
}: {
  tabs: TabDef<T>[];
  active: T;
  onSelect: (t: T) => void;
  center?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-stone-200 px-3">
      <nav className="flex items-center gap-4 self-stretch" role="tablist">
        {tabs.map((t) => (
          <button
            type="button"
            role="tab"
            aria-selected={active === t.id}
            key={t.id}
            disabled={t.disabled}
            onClick={() => onSelect(t.id)}
            className={`-mb-px flex items-center gap-1 self-stretch border-b-2 text-[13px] whitespace-nowrap disabled:cursor-default disabled:text-stone-300 ${
              active === t.id ? "border-stone-900 text-stone-900" : "border-transparent text-stone-500 hover:text-stone-800"
            }`}
          >
            {t.label}
            {!!t.badge && <span className="text-[11px] tabular-nums text-amber-700">{t.badge}</span>}
          </button>
        ))}
      </nav>
      <div className="min-w-0">{center}</div>
      <div className="flex items-center justify-end gap-1">{right}</div>
    </div>
  );
}

const iconBtn = "flex h-7 w-7 items-center justify-center rounded text-stone-500 hover:bg-stone-100 hover:text-stone-900";

/** Shows or hides the right window (chat, rubric, assessment). */
export function ChatToggle() {
  const open = usePrefs((s) => s.chatOpen);
  const setOpen = usePrefs((s) => s.setChatOpen);
  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      className={iconBtn}
      aria-pressed={open}
      aria-label={open ? "Hide chat" : "Show chat"}
      title={open ? "Hide chat" : "Show chat"}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <path d="M10 2.5v11" />
        {open && <path d="M10.6 3.2h3.2v9.6h-3.2z" fill="currentColor" stroke="none" />}
      </svg>
    </button>
  );
}

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  to?: string;
  disabled?: boolean;
}

/** One dropdown for the app-level actions (export, new essay, settings). */
export function AppMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const cls = "block w-full px-3 py-1.5 text-left text-sm text-stone-700 hover:bg-stone-50 disabled:text-stone-300";
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={iconBtn}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu"
        title="Menu"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <circle cx="3.5" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="12.5" cy="8" r="1.3" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute top-full right-0 z-50 mt-1 w-44 overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-lg">
          {items.map((it) =>
            it.to ? (
              <Link key={it.label} role="menuitem" to={it.to} className={cls} onClick={() => setOpen(false)}>
                {it.label}
              </Link>
            ) : (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                className={cls}
                onClick={() => {
                  setOpen(false);
                  it.onSelect?.();
                }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Two windows side by side, each with its own tabs: the essay side (left) and the
 * chat/rubric/assessment side (right). The right window can be hidden.
 */
export function Workspace<L extends string, R extends string>({
  title,
  leftTabs,
  leftTab,
  onLeftTab,
  left,
  rightTabs,
  rightTab,
  onRightTab,
  right,
  menu,
  forceRight = false,
}: {
  title: ReactNode;
  leftTabs: TabDef<L>[];
  leftTab: L;
  onLeftTab: (t: L) => void;
  left: ReactNode;
  rightTabs: TabDef<R>[];
  rightTab: R;
  onRightTab: (t: R) => void;
  right: ReactNode;
  menu: MenuItem[];
  /** Keep the right window shown regardless of the toggle (e.g. while choosing a rubric). */
  forceRight?: boolean;
}) {
  const chatOpen = usePrefs((s) => s.chatOpen);
  const showRight = chatOpen || forceRight;
  const controls = (
    <>
      {!forceRight && <ChatToggle />}
      <AppMenu items={menu} />
    </>
  );
  return (
    <div className="h-screen bg-white">
      <Group orientation="horizontal" className="h-full">
        <Panel id="left" defaultSize="64" minSize="35" className="flex min-h-0 flex-col">
          <TabBar
            tabs={leftTabs}
            active={leftTab}
            onSelect={onLeftTab}
            center={<div className="truncate text-center text-[13px] font-medium text-stone-800">{title}</div>}
            right={showRight ? undefined : controls}
          />
          <div className="relative min-h-0 flex-1">{left}</div>
        </Panel>
        {showRight && (
          <>
            <Separator className="w-px bg-stone-200 transition-colors hover:bg-stone-400 data-[separator=active]:bg-stone-500" />
            <Panel id="right" defaultSize="36" minSize="22" className="flex min-h-0 flex-col">
              <TabBar tabs={rightTabs} active={rightTab} onSelect={onRightTab} right={controls} />
              <div className="relative min-h-0 flex-1">{right}</div>
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}

/** A pane that stays mounted while hidden (keeps editor/chat state across tab switches). */
export function Pane({ shown, children }: { shown: boolean; children: ReactNode }) {
  return <div className={`absolute inset-0 flex flex-col ${shown ? "" : "invisible"}`}>{children}</div>;
}
