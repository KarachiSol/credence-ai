import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { IconBox, IconChat, IconFolder, IconTrash } from "../components/icons";
import type { Downloads, InstalledModel } from "../lib/downloads";
import { bytes, date } from "../lib/format";

export function MyModelsScreen({ downloads, onBrowse }: { downloads: Downloads; onBrowse: () => void }) {
  const [toDelete, setToDelete] = useState<InstalledModel | null>(null);
  const total = downloads.installed.reduce((s, m) => s + m.sizeBytes, 0);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Installed models</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {downloads.installed.length === 0
              ? "Nothing installed yet."
              : `${downloads.installed.length} model${downloads.installed.length > 1 ? "s" : ""} · ${bytes(total)} on disk`}
          </p>
        </div>
        <button
          type="button"
          onClick={downloads.openFolder}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-zinc-200 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <IconFolder width={16} height={16} />
          Open models folder
        </button>
      </div>

      {downloads.installed.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-200 px-4 py-12 text-center dark:border-zinc-800">
          <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400">
            <IconBox />
          </div>
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">Models you download will show up here.</p>
          <button
            type="button"
            onClick={onBrowse}
            className="mt-5 h-9 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
          >
            Browse models
          </button>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {downloads.installed.map((m) => (
            <li
              key={m.id}
              className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="min-w-0">
                <p className="truncate text-base font-semibold">{m.name}</p>
                <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                  {m.quant} · {bytes(m.sizeBytes)} · installed {date(m.installedAtMs)}
                </p>
                <p className="mt-2 truncate font-mono text-[11px] text-zinc-400 dark:text-zinc-500" title={m.path}>
                  {m.path}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled
                  title="Chat is coming in the next step"
                  className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <IconChat width={16} height={16} />
                  Chat
                </button>
                <button
                  type="button"
                  onClick={() => setToDelete(m)}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 px-3 text-sm font-medium text-rose-600 hover:bg-rose-50 dark:border-zinc-700 dark:text-rose-400 dark:hover:bg-rose-500/10"
                >
                  <IconTrash width={16} height={16} />
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title={`Delete ${toDelete?.name ?? ""}?`}
        confirmText="Delete"
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) void downloads.deleteInstalled(toDelete.id);
          setToDelete(null);
        }}
      >
        This frees {toDelete ? bytes(toDelete.sizeBytes) : ""} of disk space. Your chats are kept. You can download the
        model again later.
      </ConfirmDialog>
    </div>
  );
}
