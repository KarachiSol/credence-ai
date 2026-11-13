import { describe, expect, it } from "vitest";
import { launchPlan, safePlan } from "./launch";
import { SAMPLE_PROFILES } from "./profiles";
import type { HardwareProfile } from "./types";

const GB = 1024 ** 3;
const base = Object.values(SAMPLE_PROFILES)[0] as HardwareProfile;
const machine = (gpus: HardwareProfile["gpus"], ramGB = 16): HardwareProfile => ({
  ...base,
  unifiedMemory: false,
  totalRamBytes: ramGB * GB,
  gpus,
});

describe("launchPlan", () => {
  it("puts tools in the prompt for small Qwen3 models only", () => {
    expect(launchPlan("qwen3-0.6b", null, { gpu: "auto" }).nativeTools).toBe(false);
    expect(launchPlan("qwen3.5-0.8b", null, { gpu: "auto" }).nativeTools).toBe(true);
    expect(launchPlan("qwen3.6-35b-a3b", null, { gpu: "auto" }).nativeTools).toBe(true);
  });
  it("turns Vulkan on for a graphics card", () => {
    const hw = machine([{ name: "NVIDIA GeForce RTX 3060", vendor: "nvidia", vramBytes: 12 * GB }]);
    const plan = launchPlan("olmoe", hw, { gpu: "auto" });
    expect(plan.env).toContainEqual(["COLI_VULKAN", "1"]);
    expect(launchPlan("olmoe", hw, { gpu: "off" }).env).toEqual([]);
  });
  it("uses an integrated GPU for Qwen but not for OLMoE", () => {
    const hw = machine([{ name: "Intel Iris Xe", vendor: "intel", vramBytes: null }]);
    expect(launchPlan("qwen3-1.7b", hw, { gpu: "auto" }).env).toContainEqual(["COLI_VULKAN", "1"]);
    expect(launchPlan("olmoe", hw, { gpu: "auto" }).env).toEqual([]);
  });
  it("sizes the expert cache for MoE models, and can drop the plan", () => {
    const plan = launchPlan("qwen3-coder-30b-a3b", machine([], 32), { gpu: "auto" });
    expect(plan.args).toContain("--auto-tier");
    expect(plan.args).toContain("--ram");
    expect(safePlan(plan).args).not.toContain("--auto-tier");
    expect(launchPlan("qwen3-4b", machine([], 32), { gpu: "auto" }).args).toEqual([]);
  });
});
