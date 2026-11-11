import type { HardwareProfile } from "./types";

const GB = 1024 ** 3;

function profile(p: Partial<HardwareProfile> & { ramGB: number; freeGB?: number; diskFreeGB?: number }): HardwareProfile {
  const { ramGB, freeGB, diskFreeGB, ...rest } = p;
  return {
    osName: "Windows",
    osVersion: "11",
    cpuBrand: "Generic CPU",
    cpuArch: "x86_64",
    physicalCores: 8,
    logicalCores: 16,
    totalRamBytes: ramGB * GB,
    availableRamBytes: (freeGB ?? ramGB * 0.6) * GB,
    unifiedMemory: false,
    gpus: [],
    modelsDir: "C:\\Users\\me\\AppData\\Roaming\\ai.credence.desktop\\models",
    modelsDisk: { mountPoint: "C:\\", kind: "nvme", totalBytes: 1000 * GB, availableBytes: (diskFreeGB ?? 400) * GB },
    scannedAtMs: 0,
    ...rest,
  };
}

/** Sample machines used by tests and by the browser preview (outside Tauri). */
export const SAMPLE_PROFILES = {
  laptop8: profile({ ramGB: 8, cpuBrand: "Intel Core i5-8250U", modelsDisk: { mountPoint: "C:\\", kind: "ssd", totalBytes: 256 * GB, availableBytes: 60 * GB } }),
  laptop16: profile({ ramGB: 16, cpuBrand: "Intel Core i7-1165G7", gpus: [{ name: "Intel Iris Xe Graphics", vendor: "intel", vramBytes: null }] }),
  desktop32: profile({ ramGB: 32, cpuBrand: "AMD Ryzen 7 7700X", gpus: [{ name: "AMD Radeon Graphics", vendor: "amd", vramBytes: null }] }),
  gamer64: profile({ ramGB: 64, cpuBrand: "AMD Ryzen 9 7950X", gpus: [{ name: "NVIDIA GeForce RTX 4090", vendor: "nvidia", vramBytes: 24 * GB }] }),
  macPro36: profile({
    ramGB: 36,
    osName: "Darwin",
    osVersion: "15",
    cpuBrand: "Apple M3 Pro",
    cpuArch: "arm64",
    unifiedMemory: true,
    gpus: [{ name: "Apple M3 Pro GPU", vendor: "apple", vramBytes: null }],
    modelsDir: "/Users/me/Library/Application Support/ai.credence.desktop/models",
    modelsDisk: { mountPoint: "/", kind: "nvme", totalBytes: 1000 * GB, availableBytes: 500 * GB },
  }),
  hddDesktop16: profile({ ramGB: 16, modelsDisk: { mountPoint: "D:\\", kind: "hdd", totalBytes: 2000 * GB, availableBytes: 1500 * GB } }),
} satisfies Record<string, HardwareProfile>;
