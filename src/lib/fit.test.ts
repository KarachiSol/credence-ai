import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog";
import { fitModel, memoryBudget, rankModels, recommendedModels } from "./fit";
import { SAMPLE_PROFILES as P } from "./profiles";
import type { FitLabel, HardwareProfile } from "./types";

const model = (id: string) => {
  const m = CATALOG.find((x) => x.id === id);
  if (!m) throw new Error(`missing ${id}`);
  return m;
};
const label = (hw: HardwareProfile, id: string): FitLabel => fitModel(hw, model(id)).fit.label;

describe("memoryBudget", () => {
  it("keeps at least 4 GB for the OS", () => {
    expect(memoryBudget(P.laptop8).ramBudgetGB).toBeCloseTo(4);
  });
  it("keeps 20% on bigger machines", () => {
    expect(memoryBudget(P.desktop32).ramBudgetGB).toBeCloseTo(25.6);
  });
  it("adds discrete VRAM minus 1 GB", () => {
    expect(memoryBudget(P.gamer64).gpuBudgetGB).toBeCloseTo(23);
  });
  it("does not count Apple unified memory twice", () => {
    expect(memoryBudget(P.macPro36).gpuBudgetGB).toBe(0);
  });
});

describe("labels", () => {
  it("every sample machine gets at least one Recommended model", () => {
    for (const hw of Object.values(P)) {
      expect(recommendedModels(rankModels(hw, CATALOG)).length).toBeGreaterThan(0);
    }
  });

  it("8 GB laptop: small Qwen3 recommended, big models won't run", () => {
    expect(label(P.laptop8, "qwen3-1.7b")).toBe("recommended");
    expect(label(P.laptop8, "glm-5.2")).toBe("wont-run");
    expect(label(P.laptop8, "qwen3.6-35b-a3b")).toBe("wont-run");
  });

  it("16 GB laptop: Qwen3.6 35B A3B runs from SSD streaming", () => {
    expect(label(P.laptop16, "qwen3.6-35b-a3b")).not.toBe("wont-run");
  });

  it("32 GB desktop: Qwen3.6 35B A3B recommended (README: ~6 tok/s on CPU)", () => {
    const f = fitModel(P.desktop32, model("qwen3.6-35b-a3b")).fit;
    expect(f.label).toBe("recommended");
    expect(f.tokPerSec).toBeGreaterThan(5);
    expect(f.tokPerSec).toBeLessThan(15);
  });

  it("32 GB desktop: DeepSeek REAP runs slowly (README: ~0.9 tok/s at 32 GB)", () => {
    const f = fitModel(P.desktop32, model("deepseek-v4-flash-reap")).fit;
    expect(f.label).toBe("slow");
    expect(f.tokPerSec).toBeGreaterThan(0.5);
    expect(f.tokPerSec).toBeLessThan(2);
  });

  it("HDD blocks models that must stream", () => {
    const f = fitModel(P.hddDesktop16, model("qwen3.6-35b-a3b")).fit;
    expect(f.label).toBe("wont-run");
    expect(f.reason).toMatch(/SSD/);
  });

  it("flags missing disk space without changing the label", () => {
    const f = fitModel(P.laptop8, model("glm-5.2")).fit;
    expect(f.diskOk).toBe(false);
    expect(f.warnings.join(" ")).toMatch(/disk space/);
  });
});

describe("ordering", () => {
  it("groups Recommended, then slow, then won't run", () => {
    const order = { recommended: 0, slow: 1, "wont-run": 2 };
    const ranked = rankModels(P.desktop32, CATALOG).map((r) => order[r.fit.label]);
    expect(ranked).toEqual([...ranked].sort((a, b) => a - b));
  });

  it("puts the smartest Recommended model first", () => {
    const top = recommendedModels(rankModels(P.gamer64, CATALOG));
    const ranks = top.map((t) => t.model.qualityRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  it("pre-selects the highest quality Recommended variant", () => {
    expect(fitModel(P.gamer64, model("qwen3-8b")).variant.quant).toBe("Q8_0");
  });
});
