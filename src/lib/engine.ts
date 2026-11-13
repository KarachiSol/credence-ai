import { useCallback, useEffect, useRef, useState } from "react";
import { ensureColibri } from "./colibri";
import type { InstalledModel } from "./downloads";
import { listModels, type Provider } from "./llm";
import { launchPlan, safePlan, type LaunchPlan } from "./launch";
import { invoke, isTauri } from "./platform";
import type { Settings } from "./settings";
import type { HardwareProfile } from "./types";

export type EngineState = "off" | "starting" | "ready" | "error";

export interface EngineInfo {
  state: EngineState;
  provider: Provider | null;
  /** Installed model id that Colibri is serving. */
  installedId: string | null;
  label: string;
  error: string | null;
  logs: string[];
}

interface RustStatus {
  running: boolean;
  modelDir: string | null;
  exitMessage: string | null;
}

const OFF: EngineInfo = { state: "off", provider: null, installedId: null, label: "", error: null, logs: [] };
const START_TIMEOUT_MS = 15 * 60 * 1000;

/** Starts Colibri for an installed model, or connects to a custom OpenAI-compatible server. */
export function useEngine(settings: Settings, hw: HardwareProfile | null) {
  const [info, setInfo] = useState<EngineInfo>(OFF);
  const attempt = useRef(0);

  const waitUntilReady = useCallback(
    async (baseUrl: string, apiKey: string | undefined, my: number, checkRunning: boolean) => {
      const until = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < until && attempt.current === my) {
        try {
          const models = await listModels(baseUrl, apiKey, AbortSignal.timeout(3000));
          return models;
        } catch {
          // Not up yet.
        }
        if (checkRunning) {
          const st = await invoke<RustStatus>("engine_status");
          const logs = await invoke<string[]>("engine_logs");
          setInfo((i) => (attempt.current === my ? { ...i, logs } : i));
          if (!st.running) throw new Error(st.exitMessage ?? "The engine stopped while loading. See the log.");
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw new Error("The engine did not become ready in time.");
    },
    [],
  );

  const start = useCallback(
    async (model: InstalledModel) => {
      const my = ++attempt.current;
      setInfo({ ...OFF, state: "starting", installedId: model.id, label: `${model.name} · ${model.quant}` });
      if (!isTauri()) {
        await new Promise((r) => setTimeout(r, 900));
        setInfo({
          ...OFF,
          state: "ready",
          installedId: model.id,
          label: `${model.name} · ${model.quant}`,
          provider: { baseUrl: "demo", model: "demo", nativeTools: true, demo: true },
        });
        return;
      }
      const plan = launchPlan(model.modelId, hw, settings);
      const run = async (p: LaunchPlan) => {
        const startArgs = { modelDir: model.path, extraArgs: p.args, env: p.env, note: p.gpuNote };
        const builtIn = async () => {
          // Use (and if needed download) the engine Credence manages itself.
          const colibri = await ensureColibri();
          if (!colibri.python) throw new Error(`The Colibri engine needs Python 3.10 or newer. ${colibri.pythonHint}`);
          if (attempt.current === my) await invoke("engine_start", { colibriDir: "", ...startArgs });
        };
        if (!settings.colibriDir.trim()) {
          await builtIn();
        } else {
          try {
            await invoke("engine_start", { colibriDir: settings.colibriDir, ...startArgs });
          } catch (e) {
            // Their folder has no Colibri in it: fall back to the built-in engine.
            if (!String(e).includes("launcher (coli) not found")) throw e;
            await builtIn();
          }
        }
        if (attempt.current !== my) return null;
        return waitUntilReady(settings.colibriUrl, undefined, my, true);
      };
      try {
        let ids: string[] | null;
        try {
          ids = await run(plan);
        } catch (e) {
          // The memory plan is an extra: if the engine stops with it, start once more without it.
          const safe = safePlan(plan);
          const timedOut = String(e).includes("did not become ready");
          if (attempt.current !== my || timedOut || safe.args.length === plan.args.length) throw e;
          ids = await run(safe);
        }
        if (ids === null || attempt.current !== my) return;
        setInfo((i) => ({
          ...i,
          state: "ready",
          provider: { baseUrl: settings.colibriUrl, model: ids[0] ?? model.id, nativeTools: plan.nativeTools },
        }));
      } catch (e) {
        if (attempt.current !== my) return;
        const logs = await invoke<string[]>("engine_logs").catch(() => []);
        setInfo((i) => ({ ...i, state: "error", error: e instanceof Error ? e.message : String(e), logs }));
      }
    },
    [settings, hw, waitUntilReady],
  );

  const connectCustom = useCallback(async () => {
    const my = ++attempt.current;
    const url = settings.customUrl.trim();
    setInfo({ ...OFF, state: "starting", label: url });
    try {
      const ids = await listModels(url, settings.customApiKey || undefined, AbortSignal.timeout(8000));
      const model = settings.customModel.trim() || ids[0];
      if (!model) throw new Error("The server lists no models. Type the model name in Settings.");
      if (attempt.current !== my) return;
      setInfo({
        ...OFF,
        state: "ready",
        label: model,
        provider: { baseUrl: url, model, apiKey: settings.customApiKey || undefined, nativeTools: true },
      });
    } catch (e) {
      if (attempt.current !== my) return;
      setInfo({ ...OFF, state: "error", label: url, error: `Can't reach ${url}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, [settings.customUrl, settings.customApiKey, settings.customModel]);

  const stop = useCallback(async () => {
    attempt.current++;
    if (isTauri()) await invoke("engine_stop").catch(() => {});
    setInfo(OFF);
  }, []);

  // If the engine process dies while chatting, show it.
  useEffect(() => {
    if (info.state !== "ready" || !isTauri() || settings.engineMode !== "colibri") return;
    const t = setInterval(async () => {
      const st = await invoke<RustStatus>("engine_status").catch(() => null);
      if (st && !st.running) {
        const logs = await invoke<string[]>("engine_logs").catch(() => []);
        setInfo((i) => ({ ...i, state: "error", provider: null, error: st.exitMessage ?? "The engine stopped.", logs }));
      }
    }, 5000);
    return () => clearInterval(t);
  }, [info.state, settings.engineMode]);

  return { info, start, connectCustom, stop };
}

export type Engine = ReturnType<typeof useEngine>;
