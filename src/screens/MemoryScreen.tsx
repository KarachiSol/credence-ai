import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { IconBrain, IconEdit, IconPlus, IconTrash } from "../components/icons";
import { getStore, type Memory } from "../lib/db";
import { date } from "../lib/format";
import { uid } from "../lib/platform";
import type { Settings } from "../lib/settings";

interface Props {
  settings: Settings;
  onToggle: (enabled: boolean) => void;
  /** Bumped by the chat when memories change in the background. */
  version: number;
}

export function MemoryScreen({ settings, onToggle, version }: Props) {
  const [items, setItems] = useState<Memory[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState("");
  const [clearAll, setClearAll] = useState(false);

  const reload = useCallback(async () => setItems(await (await getStore()).listMemories()), []);
  useEffect(() => {
    void reload();
  }, [reload, version]);

  const save = async (m: Memory, text: string) => {
    const t = text.trim();
    if (!t) return;
    await (await getStore()).saveMemory({ ...m, text: t, updatedAt: Date.now() });
    setEditing(null);
    await reload();
  };

  const add = async () => {
    const t = adding.trim();
    if (!t) return;
    const now = Date.now();
    await (await getStore()).saveMemory({
      id: uid(),
      text: t,
      kind: "fact",
      sourceConversationId: null,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    });
    setAdding("");
    await reload();
  };

  const remove = async (id: string) => {
    await (await getStore()).deleteMemory(id);
    await reload();
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <section className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-4 sm:flex-row sm:items-center sm:p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400">
          <IconBrain />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">What Credence knows about you</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Credence learns from your chats so it understands you better over time. It works with every model and stays on
            this computer.
          </p>
        </div>
        <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            role="switch"
            checked={settings.memoryEnabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="peer sr-only"
          />
          <span className="relative h-6 w-11 rounded-full bg-zinc-300 transition-colors peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500/40 after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5 dark:bg-zinc-700" />
          {settings.memoryEnabled ? "On" : "Off"}
        </label>
      </section>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
        className="flex gap-2"
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">Add a memory</span>
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="Add something, e.g. “I work as a React developer”"
            className="h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm placeholder:text-zinc-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <button
          type="submit"
          disabled={!adding.trim()}
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <IconPlus width={16} height={16} />
          <span className="hidden sm:inline">Add</span>
        </button>
      </form>

      {items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          Nothing yet. Chat with Credence, or tell it “remember that …”.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
          {items.map((m) => (
            <li key={m.id} className="flex items-start gap-3 p-3 sm:p-4">
              {editing === m.id ? (
                <form
                  className="flex min-w-0 flex-1 flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save(m, draft);
                  }}
                >
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    autoFocus
                    className="field-sizing-content min-h-10 w-full resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-brand-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
                  />
                  <div className="flex gap-2">
                    <button type="submit" className="h-8 rounded-lg bg-brand-600 px-3 text-xs font-medium text-white">
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="h-8 rounded-lg border border-zinc-200 px-3 text-xs font-medium dark:border-zinc-700"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{m.text}</p>
                    <p className="mt-0.5 text-[11px] text-zinc-400 dark:text-zinc-500">
                      {m.kind === "preference" ? "Preference" : "Fact"} · {date(m.updatedAt)}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Edit"
                    onClick={() => {
                      setEditing(m.id);
                      setDraft(m.text);
                    }}
                    className="grid size-8 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  >
                    <IconEdit width={15} height={15} />
                  </button>
                  <button
                    type="button"
                    aria-label="Delete"
                    onClick={() => void remove(m.id)}
                    className="grid size-8 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"
                  >
                    <IconTrash width={15} height={15} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <button
          type="button"
          onClick={() => setClearAll(true)}
          className="self-start text-sm font-medium text-rose-600 hover:underline dark:text-rose-400"
        >
          Forget everything
        </button>
      )}

      <ConfirmDialog
        open={clearAll}
        title="Forget everything?"
        confirmText="Forget all"
        danger
        onCancel={() => setClearAll(false)}
        onConfirm={async () => {
          setClearAll(false);
          await (await getStore()).clearMemories();
          await reload();
        }}
      >
        All {items.length} memories will be deleted. Your chats are not deleted.
      </ConfirmDialog>
    </div>
  );
}
