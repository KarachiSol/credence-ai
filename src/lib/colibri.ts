import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "./platform";

/** The Colibri engine Credence downloads and keeps up to date by itself. */
export interface ColibriInfo {
  supported: boolean;
  installed: boolean;
  dir: string | null;
  version: string | null;
  /** Python 3.10+ version, or null when it is missing (Colibri's launcher needs it). */
  python: string | null;
  pythonHint: string;
}

export type SetupPhase = "idle" | "checking" | "downloading" | "verifying" | "extracting" | "done" | "error";

export interface ColibriSetup {
  info: ColibriInfo | null;
  phase: SetupPhase;
  done: number;
  total: number;
  error: string | null;
}

interface Progress {
  phase: SetupPhase;
  done: number;
  total: number;
  message: string | null;
}

const DEMO_INFO: ColibriInfo = {
  supported: true,
  installed: true,
  dir: "~/.local/share/ai.credence.desktop/colibri/v2.1.0",
  version: "v2.1.0",
  python: "3.12.3",
  pythonHint: "",
};

let state: ColibriSetup = { info: null, phase: "idle", done: 0, total: 0, error: null };
const subscribers = new Set<() => void>();
let listening = false;
let inflight: Promise<ColibriInfo> | null = null;

function set(patch: Partial<ColibriSetup>) {
  state = { ...state, ...patch };
  subscribers.forEach((s) => s());
}

async function listenOnce() {
  if (listening || !isTauri()) return;
  listening = true;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<Progress>("colibri-setup", ({ payload: p }) => {
    set({ phase: p.phase, done: p.done, total: p.total, error: p.phase === "error" ? p.message : null });
  });
}

export async function refreshColibri(): Promise<ColibriInfo> {
  const info = isTauri() ? await invoke<ColibriInfo>("colibri_info") : DEMO_INFO;
  set({ info });
  return info;
}

/** Installs the engine if it is missing. Safe to call many times: one install runs at a time. */
export function ensureColibri(): Promise<ColibriInfo> {
  if (inflight) return inflight;
  inflight = (async () => {
    await listenOnce();
    const info = await refreshColibri();
    if (info.installed || !isTauri()) return info;
    set({ phase: "checking", error: null, done: 0, total: 0 });
    try {
      const installed = await invoke<ColibriInfo>("colibri_install");
      set({ info: installed, phase: "done" });
      return installed;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      set({ phase: "error", error });
      throw new Error(error);
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function useColibri(): ColibriSetup {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => state,
  );
}

/** "Downloading the engine… 42%" while an install runs, else null. */
export function setupLabel(s: ColibriSetup): string | null {
  switch (s.phase) {
    case "checking":
      return "Getting the Colibri engine ready…";
    case "downloading":
      return s.total > 0
        ? `Downloading the Colibri engine (one time)… ${Math.floor((s.done / s.total) * 100)}%`
        : "Downloading the Colibri engine (one time)…";
    case "verifying":
    case "extracting":
      return "Installing the Colibri engine…";
    default:
      return null;
  }
}
