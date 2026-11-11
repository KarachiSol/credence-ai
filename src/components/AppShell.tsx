import { useEffect, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { IconBox, IconChat, IconClose, IconDownload, IconMenu, IconModels, IconSettings } from "./icons";

export type ScreenId = "models" | "my-models" | "downloads" | "chat" | "settings";

export const NAV: { id: ScreenId; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: "models", label: "Models", icon: IconModels },
  { id: "my-models", label: "My models", icon: IconBox },
  { id: "downloads", label: "Downloads", icon: IconDownload },
  { id: "chat", label: "Chat", icon: IconChat },
  { id: "settings", label: "Settings", icon: IconSettings },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid size-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">C</div>
      <span className="text-[15px] font-semibold tracking-tight">Credence AI</span>
    </div>
  );
}

type Badges = Partial<Record<ScreenId, number>>;

function NavList({ active, onSelect, badges }: { active: ScreenId; onSelect: (id: ScreenId) => void; badges?: Badges }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map(({ id, label, icon: Icon }) => {
        const on = id === active;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            aria-current={on ? "page" : undefined}
            className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors ${
              on
                ? "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400"
                : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            }`}
          >
            <Icon width={18} height={18} />
            <span className="flex-1 text-left">{label}</span>
            {!!badges?.[id] && (
              <span
                className={`min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold ${
                  on
                    ? "bg-brand-600 text-white"
                    : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                }`}
              >
                {badges[id]}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

function EnginePill() {
  // Colibri wiring comes in a later step; until then the engine is "not set up".
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-zinc-200 px-2.5 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
      <span className="size-1.5 rounded-full bg-zinc-400" />
      <span className="hidden sm:inline">Engine:</span> not loaded
    </span>
  );
}

function UpdateButton({ version, onClick }: { version: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-xl border border-brand-100 bg-brand-50 p-2.5 text-left hover:bg-brand-100 dark:border-brand-500/20 dark:bg-brand-500/10 dark:hover:bg-brand-500/15"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-brand-600 text-white">
        <IconDownload width={16} height={16} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-brand-700 dark:text-brand-400">Update available</span>
        <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">Version {version}. Click to install</span>
      </span>
    </button>
  );
}

interface Props {
  active: ScreenId;
  onSelect: (id: ScreenId) => void;
  title: string;
  /** Small counters next to nav items, e.g. active downloads. */
  badges?: Badges;
  /** Shown at the bottom of the sidebar when a new version exists. */
  update?: { version: string; onOpen: () => void } | null;
  children: ReactNode;
}

export function AppShell({ active, onSelect, title, badges, update, children }: Props) {
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const select = (id: ScreenId) => {
    onSelect(id);
    setDrawer(false);
  };

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Sidebar: always visible from md (768px) up. */}
      <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r border-zinc-200 bg-white px-3 py-4 md:flex dark:border-zinc-800 dark:bg-zinc-900">
        <div className="px-1.5">
          <Logo />
        </div>
        <NavList active={active} onSelect={select} badges={badges} />
        <div className="mt-auto flex flex-col gap-3">
          {update && <UpdateButton version={update.version} onClick={update.onOpen} />}
          <p className="px-2.5 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">
            Your chats stay on this computer.
          </p>
        </div>
      </aside>

      {/* Drawer below md. */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-zinc-950/40"
            onClick={() => setDrawer(false)}
          />
          <div className="relative flex h-full w-72 max-w-[85vw] flex-col gap-6 bg-white px-3 py-4 shadow-xl dark:bg-zinc-900">
            <div className="flex items-center justify-between px-1.5">
              <Logo />
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setDrawer(false)}
                className="grid size-9 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <IconClose />
              </button>
            </div>
            <NavList active={active} onSelect={select} badges={badges} />
            {update && (
              <div className="mt-auto">
                <UpdateButton
                  version={update.version}
                  onClick={() => {
                    setDrawer(false);
                    update.onOpen();
                  }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 bg-white/80 px-4 backdrop-blur sm:px-6 dark:border-zinc-800 dark:bg-zinc-900/80">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setDrawer(true)}
            className="relative -ml-2 grid size-9 place-items-center rounded-lg text-zinc-600 hover:bg-zinc-100 md:hidden dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <IconMenu />
            {update && (
              <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-brand-600 ring-2 ring-white dark:ring-zinc-900" />
            )}
          </button>
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h1>
          <EnginePill />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
