import { useCallback, useState } from "react";

export interface Settings {
  /** "colibri": start Colibri ourselves. "custom": any OpenAI-compatible server (Colibri started by hand, LM Studio, Ollama…). */
  engineMode: "colibri" | "custom";
  /** Folder with the Colibri release (has coli.cmd / coli). */
  colibriDir: string;
  colibriUrl: string;
  customUrl: string;
  customModel: string;
  customApiKey: string;
  /** Empty = Documents/Credence. */
  workspaceDir: string;
  memoryEnabled: boolean;
  searchProvider: "duckduckgo" | "brave";
  braveKey: string;
  /** Pages the search tool opens and reads automatically (0–3). */
  searchAutoRead: number;
  temperature: number;
  /** "auto": use the graphics card (Vulkan) when it helps. "off": CPU only. */
  gpu: "auto" | "off";
}

export const DEFAULT_SETTINGS: Settings = {
  engineMode: "colibri",
  colibriDir: "",
  colibriUrl: "http://127.0.0.1:8000/v1",
  customUrl: "http://127.0.0.1:8000/v1",
  customModel: "",
  customApiKey: "",
  workspaceDir: "",
  memoryEnabled: true,
  searchProvider: "duckduckgo",
  braveKey: "",
  searchAutoRead: 2,
  temperature: 0.6,
  gpu: "auto",
};

const KEY = "credence.settings.v1";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Settings live on this computer only. */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Storage blocked: keep the change for this session only.
      }
      return next;
    });
  }, []);
  return { settings, update };
}
