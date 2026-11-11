import { invoke, isTauri } from "@tauri-apps/api/core";
import { SAMPLE_PROFILES } from "./profiles";
import type { HardwareProfile } from "./types";

/** Real scan inside the desktop app; a sample machine in a plain browser preview. */
export async function scanHardware(): Promise<HardwareProfile> {
  if (isTauri()) return invoke<HardwareProfile>("scan_hardware");
  await new Promise((r) => setTimeout(r, 600));
  return { ...SAMPLE_PROFILES.laptop16, scannedAtMs: Date.now() };
}
