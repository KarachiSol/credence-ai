import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

export type UpdateStatus = "idle" | "available" | "downloading" | "restarting" | "error";

export interface UpdateState {
  status: UpdateStatus;
  version: string | null;
  notes: string | null;
  /** 0..1 while downloading, null when size is unknown. */
  progress: number | null;
  error: string | null;
}

interface PendingUpdate {
  version: string;
  body?: string;
  downloadAndInstall: (cb: (e: DownloadEvent) => void) => Promise<void>;
}

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** Browser preview only: open the app with `?demo-update` to see the update UI. */
function demoUpdate(): PendingUpdate | null {
  if (typeof window === "undefined" || !new URLSearchParams(window.location.search).has("demo-update")) return null;
  return {
    version: "0.2.0",
    body: "Downloads now resume after a restart.\nFaster model list.",
    async downloadAndInstall(cb) {
      const total = 5_000_000;
      cb({ event: "Started", data: { contentLength: total } });
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 120));
        cb({ event: "Progress", data: { chunkLength: total / 20 } });
      }
      cb({ event: "Finished" });
    },
  };
}

async function findUpdate(): Promise<PendingUpdate | null> {
  if (!isTauri()) return demoUpdate();
  const { check } = await import("@tauri-apps/plugin-updater");
  return (await check()) as PendingUpdate | null;
}

const INITIAL: UpdateState = { status: "idle", version: null, notes: null, progress: null, error: null };

/** Checks once on start-up (and every 6 hours while the app stays open). */
export function useUpdater() {
  const [state, setState] = useState<UpdateState>(INITIAL);
  const pending = useRef<PendingUpdate | null>(null);

  const checkNow = useCallback(async () => {
    try {
      const update = await findUpdate();
      if (!update) return;
      pending.current = update;
      setState((s) =>
        s.status === "downloading" || s.status === "restarting"
          ? s
          : { ...INITIAL, status: "available", version: update.version, notes: update.body ?? null },
      );
    } catch {
      // No internet or no release yet: stay quiet, the app works without updates.
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(checkNow, 3000);
    const every = setInterval(checkNow, 6 * 60 * 60 * 1000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [checkNow]);

  const install = useCallback(async () => {
    const update = pending.current;
    if (!update) return;
    let total = 0;
    let done = 0;
    setState((s) => ({ ...s, status: "downloading", progress: 0, error: null }));
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        if (e.event === "Progress") {
          done += e.data.chunkLength;
          setState((s) => ({ ...s, progress: total ? Math.min(done / total, 1) : null }));
        }
      });
      setState((s) => ({ ...s, status: "restarting", progress: 1 }));
      if (isTauri()) {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      }
    } catch (e) {
      setState((s) => ({ ...s, status: "error", error: String(e) }));
    }
  }, []);

  return { state, install, checkNow };
}
