/** Mirrors `HardwareProfile` in src-tauri/src/hardware.rs. */
export interface GpuInfo {
  name: string;
  vendor: "nvidia" | "amd" | "intel" | "apple" | "other";
  vramBytes: number | null;
}

export type DiskKind = "nvme" | "ssd" | "hdd" | "unknown";

export interface DiskInfo {
  mountPoint: string;
  kind: DiskKind;
  totalBytes: number;
  availableBytes: number;
}

export interface HardwareProfile {
  osName: string;
  osVersion: string;
  cpuBrand: string;
  cpuArch: string;
  physicalCores: number | null;
  logicalCores: number;
  totalRamBytes: number;
  availableRamBytes: number;
  unifiedMemory: boolean;
  gpus: GpuInfo[];
  modelsDir: string;
  modelsDisk: DiskInfo | null;
  scannedAtMs: number;
}

export interface ModelVariant {
  /** Quantization name shown to the user, e.g. "Q4_K_M". */
  quant: string;
  /** Average bits per weight for this quantization. */
  bitsPerWeight: number;
  /** Download size in GB. */
  sizeGB: number;
  /** Colibri's "won't start below" RAM number, when published. */
  ramMinGB?: number;
  /** Colibri's "runs as measured from" RAM number, when published. */
  ramGoodGB?: number;
  /** File (or folder) inside the Hugging Face repo. */
  file: string;
}

export interface CatalogModel {
  id: string;
  name: string;
  publisher: string;
  hfRepo: string;
  description: string;
  /** GGUF `general.architecture`, must be one Colibri supports. */
  architecture: string;
  kind: "dense" | "moe";
  totalParamsB: number;
  activeParamsB: number;
  /** Higher = smarter. Used to order the Recommended list. */
  qualityRank: number;
  tags: string[];
  variants: ModelVariant[];
}

export type FitLabel = "recommended" | "slow" | "wont-run";

export interface FitResult {
  label: FitLabel;
  /** One short sentence shown under the label. */
  reason: string;
  tokPerSec: number;
  ramMinGB: number;
  ramGoodGB: number;
  memBudgetGB: number;
  /** 1 = all hot weights in memory, 0 = experts always streamed from disk. */
  inMemoryFrac: number;
  diskNeededGB: number;
  /** null when the models disk is unknown. */
  diskOk: boolean | null;
  warnings: string[];
}
