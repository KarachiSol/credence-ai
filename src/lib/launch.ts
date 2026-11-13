import { CATALOG } from "./catalog";
import { memoryBudget } from "./fit";
import type { Settings } from "./settings";
import type { CatalogModel, HardwareProfile } from "./types";

/**
 * How Credence starts `coli serve` for one model. Colibri leaves the GPU off and the
 * expert cache small unless asked, so a model can run far slower than it could.
 * Everything here mirrors what Colibri's own `coli setup` would choose
 * (c/setup_flow.py: run_environment, applies_plan; checked on v2.1.0).
 */
export interface LaunchPlan {
  /** Extra `coli serve` flags. */
  args: string[];
  /** Extra environment for the engine. */
  env: [string, string][];
  /** Give the server the API's `tools` field (false: tools go into the prompt). */
  nativeTools: boolean;
  /** Short line for the engine log, e.g. "GPU: NVIDIA GeForce RTX 3060 (Vulkan)". */
  gpuNote: string;
}

/** GGUF architectures that Colibri runs with its qwen36 or qwen38 engine. */
const QWEN_ENGINE = new Set(["qwen3", "qwen3moe", "qwen35", "qwen35moe", "qwen4exp"]);

export function catalogModelFor(modelId: string): CatalogModel | undefined {
  return CATALOG.find((m) => m.id === modelId);
}

/** A GPU with its own memory (not one that shares the system RAM). */
function discreteGpu(hw: HardwareProfile) {
  return hw.gpus.find((g) => (g.vendor === "nvidia" || g.vendor === "amd") && (g.vramBytes ?? 0) >= 1.5 * 1024 ** 3);
}

/** Any GPU Vulkan can use on Windows or Linux (Apple uses Metal, which this release does not ship). */
function anyGpu(hw: HardwareProfile) {
  return hw.unifiedMemory ? undefined : hw.gpus.find((g) => g.vendor !== "apple");
}

export function launchPlan(modelId: string, hw: HardwareProfile | null, settings: Pick<Settings, "gpu">): LaunchPlan {
  const model = catalogModelFor(modelId);
  const arch = model?.architecture ?? "";
  const args: string[] = [];
  const env: [string, string][] = [];

  // Qwen3 dense (0.6B to 8B) was trained on JSON tool calls. Colibri's server gives every
  // Qwen model the XML format of Qwen3.6 and reads only that back, so the small models'
  // calls were lost. Describing the tools in the prompt in Qwen3's own format fixes it.
  const nativeTools = arch !== "qwen3";

  // GPU through Vulkan. A discrete card helps every engine. An integrated one shares the
  // RAM, and Colibri measured it faster only for the Qwen engines (slower for OLMoE).
  let gpuNote = "GPU: off (CPU only)";
  if (hw && settings.gpu !== "off") {
    const gpu = discreteGpu(hw) ?? (QWEN_ENGINE.has(arch) ? anyGpu(hw) : undefined);
    if (gpu) {
      env.push(["COLI_VULKAN", "1"]);
      gpuNote = `GPU: ${gpu.name} (Vulkan)`;
    } else if (anyGpu(hw)) {
      gpuNote = "GPU: off (an integrated GPU is slower than the CPU for this model)";
    }
  } else if (settings.gpu === "off") {
    gpuNote = "GPU: off (turned off in Settings)";
  }

  // Mixture-of-experts models: let Colibri size its expert cache to this machine's RAM.
  // Without it Qwen3.6 keeps a fixed 8 experts a layer (Colibri #2003: 3.6 tok/s against
  // 17.5 with the plan).
  if (model?.kind === "moe" && hw) {
    const budget = Math.floor(memoryBudget(hw).ramBudgetGB);
    if (budget >= 4) args.push("--ram", String(budget));
    args.push("--auto-tier");
  }

  return { args, env, nativeTools, gpuNote };
}

/** The same plan without the extras that could stop an engine from starting. */
export function safePlan(plan: LaunchPlan): LaunchPlan {
  return { ...plan, args: plan.args.filter((a) => a !== "--auto-tier") };
}
