import { useEffect, useRef } from "react";
import type { UpdateState } from "../lib/updater";
import { IconDownload } from "./icons";

interface Props {
  open: boolean;
  state: UpdateState;
  onInstall: () => void;
  onLater: () => void;
}

export function UpdateDialog({ open, state, onInstall, onLater }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const busy = state.status === "downloading" || state.status === "restarting";
  const pct = state.progress == null ? null : Math.round(state.progress * 100);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onLater();
      }}
      aria-labelledby="update-title"
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-zinc-950/50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
    >
      <div className="p-5 sm:p-6">
        <div className="grid size-10 place-items-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400">
          <IconDownload />
        </div>
        <h2 id="update-title" className="mt-4 text-lg font-semibold">
          Update available
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Credence AI {state.version} is ready to install. Your chats and models stay as they are.
        </p>

        {state.notes && (
          <div className="mt-4 max-h-40 overflow-y-auto rounded-xl bg-zinc-50 p-3 text-sm whitespace-pre-line text-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300">
            {state.notes}
          </div>
        )}

        {busy && (
          <div className="mt-4" role="status" aria-live="polite">
            <div className="flex justify-between text-xs text-zinc-500 dark:text-zinc-400">
              <span>{state.status === "restarting" ? "Restarting…" : "Downloading…"}</span>
              {pct != null && <span>{pct}%</span>}
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div
                className={`h-full rounded-full bg-brand-600 transition-[width] ${pct == null ? "w-1/3 animate-pulse" : ""}`}
                style={pct == null ? undefined : { width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {state.status === "error" && (
          <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            The update failed. Please try again later.
          </p>
        )}
      </div>

      <div className="flex flex-col-reverse gap-2 border-t border-zinc-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6 dark:border-zinc-800">
        <button
          type="button"
          onClick={onLater}
          disabled={busy}
          className="h-9 rounded-lg border border-zinc-200 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Later
        </button>
        <button
          type="button"
          onClick={onInstall}
          disabled={busy}
          className="h-9 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {state.status === "error" ? "Try again" : "Update and restart"}
        </button>
      </div>
    </dialog>
  );
}
