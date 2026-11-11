import type {
  CatalogModel,
  DiskKind,
  FitLabel,
  FitResult,
  HardwareProfile,
  ModelVariant,
} from "./types";

/** All tunable numbers live here. See docs/mvp-requirements-and-hardware-model-fit.md §5. */
export const FIT_CONFIG = {
  osReserveMinGB: 4,
  osReserveFrac: 0.2,
  overheadGB: 1.5,
  /** Share of weights that are non-expert ("shared") in a MoE model, when unknown. */
  moeSharedFrac: 0.1,
  /** Hot expert cache: share of would-be disk reads that still hit RAM (Colibri reports ~60%). */
  hotCacheHit: 0.6,
  efficiency: 0.5,
  recommendedTokPerSec: 5,
  minUsableTokPerSec: 0.5,
  diskMargin: 1.1,
  /** Memory bandwidth in GB/s. */
  bw: {
    ram: 40,
    appleBase: 100,
    applePro: 200,
    appleMax: 400,
    appleUltra: 800,
    gpu: 300,
  },
  /** Effective random-read bandwidth in GB/s. */
  diskBw: { nvme: 6, ssd: 0.5, hdd: 0.05, unknown: 0.5 } satisfies Record<DiskKind, number>,
};

const GB = 1024 ** 3;
export const toGB = (bytes: number) => bytes / GB;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface MemoryBudget {
  totalGB: number;
  availableNowGB: number;
  ramBudgetGB: number;
  gpuBudgetGB: number;
  memBudgetGB: number;
}

export function memoryBudget(hw: HardwareProfile, cfg = FIT_CONFIG): MemoryBudget {
  const totalGB = toGB(hw.totalRamBytes);
  const reserve = Math.max(cfg.osReserveMinGB, totalGB * cfg.osReserveFrac);
  const ramBudgetGB = Math.max(0, totalGB - reserve);
  // Apple Silicon shares RAM with the GPU, so VRAM is not extra memory.
  const vram = hw.unifiedMemory
    ? 0
    : Math.max(
        0,
        ...hw.gpus
          .filter((g) => g.vendor === "nvidia" || g.vendor === "amd")
          .map((g) => toGB(g.vramBytes ?? 0)),
      );
  const gpuBudgetGB = vram > 1 ? vram - 1 : 0;
  return {
    totalGB,
    availableNowGB: toGB(hw.availableRamBytes),
    ramBudgetGB,
    gpuBudgetGB,
    memBudgetGB: ramBudgetGB + gpuBudgetGB,
  };
}

export function ramBandwidth(hw: HardwareProfile, cfg = FIT_CONFIG): number {
  if (!hw.unifiedMemory) return cfg.bw.ram;
  const brand = hw.cpuBrand.toLowerCase();
  if (brand.includes("ultra")) return cfg.bw.appleUltra;
  if (brand.includes("max")) return cfg.bw.appleMax;
  if (brand.includes("pro")) return cfg.bw.applePro;
  return cfg.bw.appleBase;
}

/** RAM needs from the catalog, or estimated from size when Colibri gives none. */
export function ramNeeds(model: CatalogModel, v: ModelVariant, cfg = FIT_CONFIG) {
  const bytesPerParam = v.bitsPerWeight / 8;
  const weightsGB = model.totalParamsB * bytesPerParam;
  const activeGB = model.activeParamsB * bytesPerParam;
  let min: number;
  let good: number;
  if (model.kind === "dense") {
    min = weightsGB + cfg.overheadGB;
    good = min;
  } else {
    const sharedGB = weightsGB * cfg.moeSharedFrac;
    const expertGB = weightsGB - sharedGB;
    min = sharedGB + 2 * activeGB + cfg.overheadGB;
    good = Math.min(min + expertGB * 0.25, weightsGB + cfg.overheadGB);
  }
  return {
    ramMinGB: v.ramMinGB ?? min,
    ramGoodGB: Math.max(v.ramGoodGB ?? good, v.ramMinGB ?? min),
    activeGB,
  };
}

const fmt = (n: number) => (n >= 10 ? Math.round(n).toString() : n.toFixed(1));

export function speedText(tokPerSec: number): string {
  // Roughly 0.75 English words per token.
  const words = tokPerSec * 0.75;
  if (words >= 1) return `about ${fmt(words)} words/sec`;
  return `about 1 word every ${fmt(1 / Math.max(words, 0.01))} seconds`;
}

export function fitVariant(
  hw: HardwareProfile,
  model: CatalogModel,
  v: ModelVariant,
  cfg = FIT_CONFIG,
): FitResult {
  const budget = memoryBudget(hw, cfg);
  const { ramMinGB, ramGoodGB, activeGB } = ramNeeds(model, v, cfg);
  const mem = budget.memBudgetGB;

  // Memory needed to keep the whole model in RAM/VRAM (no disk streaming at all).
  const fullGB = Math.max(ramGoodGB, v.sizeGB + cfg.overheadGB);
  const inMemoryFrac = mem >= fullGB ? 1 : clamp((mem - ramMinGB) / (fullGB - ramMinGB), 0, 1);

  // The share of the model that fits in VRAM is read at GPU speed.
  const gpuFrac = clamp(budget.gpuBudgetGB / fullGB, 0, 1);
  const ramBw = ramBandwidth(hw, cfg);
  const memBw = 1 / (gpuFrac / cfg.bw.gpu + (1 - gpuFrac) / ramBw);
  const diskKind: DiskKind = hw.modelsDisk?.kind ?? "unknown";
  const diskBw = cfg.diskBw[diskKind];

  const streamed = (1 - inMemoryFrac) * (1 - cfg.hotCacheHit);
  const tMem = (activeGB * (1 - streamed)) / memBw;
  const tDisk = (activeGB * streamed) / diskBw;
  const tokPerSec = cfg.efficiency / (tMem + tDisk);

  const diskNeededGB = v.sizeGB * cfg.diskMargin;
  const diskOk = hw.modelsDisk ? toGB(hw.modelsDisk.availableBytes) >= diskNeededGB : null;

  let label: FitLabel;
  let reason: string;
  if (mem < ramMinGB) {
    label = "wont-run";
    reason = `Needs at least ${fmt(ramMinGB)} GB of memory. Your computer can give it ${fmt(mem)} GB.`;
  } else if (diskKind === "hdd" && inMemoryFrac < 1) {
    label = "wont-run";
    reason = "Needs an SSD. Your models folder is on a hard disk.";
  } else if (tokPerSec < cfg.minUsableTokPerSec) {
    label = "wont-run";
    reason = `Would be extremely slow (${speedText(tokPerSec)}).`;
  } else if (tokPerSec < cfg.recommendedTokPerSec) {
    label = "slow";
    reason = `Runs, but slowly: ${speedText(tokPerSec)}.`;
  } else {
    label = "recommended";
    reason = `Runs well: ${speedText(tokPerSec)}.`;
  }

  const warnings: string[] = [];
  if (diskOk === false) {
    warnings.push(
      `Not enough disk space: needs ${fmt(diskNeededGB)} GB, ${fmt(toGB(hw.modelsDisk!.availableBytes))} GB free.`,
    );
  }
  if (label !== "wont-run" && budget.availableNowGB < ramMinGB) {
    warnings.push("Close some apps first. Not enough memory is free right now.");
  }

  return {
    label,
    reason,
    tokPerSec,
    ramMinGB,
    ramGoodGB,
    memBudgetGB: mem,
    inMemoryFrac,
    diskNeededGB,
    diskOk,
    warnings,
  };
}

const LABEL_ORDER: Record<FitLabel, number> = { recommended: 0, slow: 1, "wont-run": 2 };

export interface ModelFit {
  model: CatalogModel;
  /** Pre-selected variant: best quality that is Recommended, else the fastest one that runs. */
  variant: ModelVariant;
  fit: FitResult;
  variantFits: { variant: ModelVariant; fit: FitResult }[];
}

export function fitModel(hw: HardwareProfile, model: CatalogModel, cfg = FIT_CONFIG): ModelFit {
  const variantFits = model.variants.map((variant) => ({ variant, fit: fitVariant(hw, model, variant, cfg) }));
  const recommended = variantFits
    .filter((x) => x.fit.label === "recommended")
    .sort((a, b) => b.variant.bitsPerWeight - a.variant.bitsPerWeight);
  const pick =
    recommended[0] ??
    [...variantFits].sort(
      (a, b) => LABEL_ORDER[a.fit.label] - LABEL_ORDER[b.fit.label] || b.fit.tokPerSec - a.fit.tokPerSec,
    )[0];
  return { model, variant: pick.variant, fit: pick.fit, variantFits };
}

/** All models, grouped Recommended → Slow → Won't run, smartest first inside each group. */
export function rankModels(hw: HardwareProfile, models: CatalogModel[], cfg = FIT_CONFIG): ModelFit[] {
  return models
    .map((m) => fitModel(hw, m, cfg))
    .sort(
      (a, b) =>
        LABEL_ORDER[a.fit.label] - LABEL_ORDER[b.fit.label] ||
        b.model.qualityRank - a.model.qualityRank ||
        b.fit.tokPerSec - a.fit.tokPerSec,
    );
}

/** Top section: up to `limit` Recommended models, smartest first. */
export function recommendedModels(ranked: ModelFit[], limit = 5): ModelFit[] {
  return ranked.filter((r) => r.fit.label === "recommended").slice(0, limit);
}
