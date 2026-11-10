import type { ReactNode } from "react";
import { memoryBudget } from "../lib/fit";
import { bytesToGb, gb } from "../lib/format";
import type { HardwareProfile } from "../lib/types";
import { IconCpu, IconDisk, IconGpu, IconMemory, IconRefresh } from "./icons";

const DISK_TEXT = { nvme: "NVMe SSD", ssd: "SSD", hdd: "Hard disk", unknown: "Disk" } as const;

function Stat({ icon, label, value, sub }: { icon: ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 gap-3">
      <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
        <p className="truncate text-sm font-semibold" title={value}>
          {value}
        </p>
        {sub && <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{sub}</p>}
      </div>
    </div>
  );
}

interface Props {
  hw: HardwareProfile | null;
  scanning: boolean;
  error: string | null;
  onRescan: () => void;
}

export function HardwareCard({ hw, scanning, error, onRescan }: Props) {
  const budget = hw ? memoryBudget(hw) : null;
  const gpu = hw?.gpus[0];
  const disk = hw?.modelsDisk;

  return (
    <section
      aria-label="Your computer"
      className="@container rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Your computer</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Labels below are based on this. Nothing leaves your machine.
          </p>
        </div>
        <button
          type="button"
          onClick={onRescan}
          disabled={scanning}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <IconRefresh width={14} height={14} className={scanning ? "animate-spin" : ""} />
          {scanning ? "Scanning…" : "Rescan"}
        </button>
      </div>

      {error && (
        <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          Couldn't read your hardware: {error}
        </p>
      )}

      {!hw && !error && (
        <div className="grid grid-cols-1 gap-4 @md:grid-cols-2 @4xl:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex gap-3">
              <div className="size-9 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
              <div className="flex-1 space-y-2 pt-0.5">
                <div className="h-2.5 w-16 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
                <div className="h-3 w-32 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
              </div>
            </div>
          ))}
        </div>
      )}

      {hw && budget && (
        <div className="grid grid-cols-1 gap-4 @md:grid-cols-2 @4xl:grid-cols-4">
          <Stat
            icon={<IconCpu />}
            label="Processor"
            value={hw.cpuBrand || hw.cpuArch}
            sub={`${hw.physicalCores ?? "?"} cores · ${hw.logicalCores} threads`}
          />
          <Stat
            icon={<IconMemory />}
            label="Memory"
            value={`${gb(budget.totalGB)} RAM`}
            sub={`${gb(budget.availableNowGB)} free now · ${gb(budget.ramBudgetGB)} usable for AI`}
          />
          <Stat
            icon={<IconGpu />}
            label="Graphics"
            value={gpu ? gpu.name : "No graphics card found"}
            sub={
              hw.unifiedMemory
                ? "Shares memory with the processor"
                : gpu?.vramBytes
                  ? `${bytesToGb(gpu.vramBytes)} video memory`
                  : "Uses the processor (CPU) for AI"
            }
          />
          <Stat
            icon={<IconDisk />}
            label="Models drive"
            value={disk ? `${DISK_TEXT[disk.kind]} · ${bytesToGb(disk.availableBytes)} free` : "Unknown"}
            sub={disk ? `of ${bytesToGb(disk.totalBytes)} on ${disk.mountPoint}` : undefined}
          />
        </div>
      )}
    </section>
  );
}
