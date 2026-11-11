import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogModel, ModelVariant } from "./types";

/** Mirrors `downloads.rs`. */
export interface DownloadSpec {
  modelId: string;
  name: string;
  quant: string;
  repo: string;
  file: string;
}

export type JobStatus = "queued" | "downloading" | "paused" | "verifying" | "done" | "error";

export interface Job {
  id: string;
  spec: DownloadSpec;
  status: JobStatus;
  totalBytes: number;
  doneBytes: number;
  bytesPerSec: number;
  error: string | null;
  updatedAtMs: number;
}

export interface InstalledModel {
  id: string;
  modelId: string;
  name: string;
  quant: string;
  repo: string;
  files: string[];
  sizeBytes: number;
  path: string;
  installedAtMs: number;
}

/** Same rule as `job_id` in Rust. */
export function jobId(modelId: string, quant: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${clean(modelId)}--${clean(quant)}`;
}

export function specFor(model: CatalogModel, v: ModelVariant): DownloadSpec {
  return { modelId: model.id, name: model.name, quant: v.quant, repo: model.hfRepo, file: v.file };
}

export const isActive = (s: JobStatus) => s === "queued" || s === "downloading" || s === "verifying";

// ---------------------------------------------------------------------------
// Browser preview: a fake downloader so the screens can be seen with `bun run dev`.

const GB = 1024 ** 3;
const demo = {
  jobs: new Map<string, Job>(),
  installed: new Map<string, InstalledModel>(),
  timers: new Map<string, ReturnType<typeof setInterval>>(),
  listeners: new Set<(j: Job) => void>(),
  sizes: new Map<string, number>(),
};

function demoEmit(j: Job) {
  demo.jobs.set(j.id, j);
  demo.listeners.forEach((l) => l(j));
}

function demoStart(spec: DownloadSpec, sizeGB: number): Job {
  const id = jobId(spec.modelId, spec.quant);
  const prev = demo.jobs.get(id);
  const total = Math.round(sizeGB * GB);
  let job: Job = {
    id,
    spec,
    status: "downloading",
    totalBytes: total,
    doneBytes: prev && prev.status !== "done" ? prev.doneBytes : 0,
    bytesPerSec: 0,
    error: null,
    updatedAtMs: Date.now(),
  };
  demoEmit(job);
  const speed = 45 * 1024 ** 2;
  // Fast-forward: the preview finishes in about 15 seconds.
  const step = Math.max(total / 60, speed / 4);
  clearInterval(demo.timers.get(id));
  demo.timers.set(
    id,
    setInterval(() => {
      const done = Math.min(job.doneBytes + step, total);
      job = { ...job, doneBytes: done, bytesPerSec: speed, updatedAtMs: Date.now() };
      if (done >= total) {
        clearInterval(demo.timers.get(id));
        job = { ...job, status: "done", bytesPerSec: 0 };
        demo.installed.set(id, {
          id,
          modelId: spec.modelId,
          name: spec.name,
          quant: spec.quant,
          repo: spec.repo,
          files: [spec.file],
          sizeBytes: total,
          path: `C:\\Users\\you\\AppData\\Roaming\\ai.credence.desktop\\models\\${id}`,
          installedAtMs: Date.now(),
        });
      }
      demoEmit(job);
    }, 250),
  );
  return job;
}

// ---------------------------------------------------------------------------

export function useDownloads() {
  const [jobs, setJobs] = useState<Map<string, Job>>(new Map());
  const [installed, setInstalled] = useState<InstalledModel[]>([]);

  const refreshInstalled = useCallback(async () => {
    setInstalled(isTauri() ? await invoke<InstalledModel[]>("installed_list") : [...demo.installed.values()]);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    const onJob = (j: Job) => {
      setJobs((m) => new Map(m).set(j.id, j));
      if (j.status === "done") void refreshInstalled();
    };
    (async () => {
      if (isTauri()) {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen<Job>("download-update", (e) => onJob(e.payload));
        if (!alive) return off();
        unlisten = off;
        const list = await invoke<Job[]>("downloads_list");
        setJobs(new Map(list.map((j) => [j.id, j])));
      } else {
        demo.listeners.add(onJob);
        unlisten = () => demo.listeners.delete(onJob);
        setJobs(new Map(demo.jobs));
      }
      await refreshInstalled();
    })().catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [refreshInstalled]);

  const start = useCallback(async (spec: DownloadSpec, sizeGB: number) => {
    const job = isTauri() ? await invoke<Job>("download_start", { spec }) : demoStart(spec, sizeGB);
    setJobs((m) => new Map(m).set(job.id, job));
  }, []);

  const pause = useCallback(async (id: string) => {
    if (isTauri()) return invoke("download_pause", { id });
    clearInterval(demo.timers.get(id));
    const j = demo.jobs.get(id);
    if (j) demoEmit({ ...j, status: "paused", bytesPerSec: 0 });
  }, []);

  const resume = useCallback(
    async (job: Job) => start(job.spec, job.totalBytes / GB),
    [start],
  );

  const remove = useCallback(async (id: string) => {
    if (isTauri()) await invoke("download_remove", { id });
    else {
      clearInterval(demo.timers.get(id));
      demo.jobs.delete(id);
    }
    setJobs((m) => {
      const n = new Map(m);
      n.delete(id);
      return n;
    });
  }, []);

  const deleteInstalled = useCallback(
    async (id: string) => {
      if (isTauri()) await invoke("installed_delete", { id });
      else demo.installed.delete(id);
      demo.jobs.delete(id);
      setJobs((m) => {
        const n = new Map(m);
        n.delete(id);
        return n;
      });
      await refreshInstalled();
    },
    [refreshInstalled],
  );

  const openFolder = useCallback(async () => {
    if (isTauri()) await invoke("open_models_folder");
  }, []);

  // Stable order: newest job first, by when it first appeared. Sorting by last update made
  // two running downloads swap places on every progress tick.
  const firstSeen = useRef(new Map<string, number>());
  const jobList = useMemo(() => {
    const seen = firstSeen.current;
    const fresh = [...jobs.values()].filter((j) => !seen.has(j.id)).sort((a, b) => a.updatedAtMs - b.updatedAtMs);
    for (const j of fresh) seen.set(j.id, seen.size);
    return [...jobs.values()].sort((a, b) => (seen.get(b.id) ?? 0) - (seen.get(a.id) ?? 0));
  }, [jobs]);
  const installedIds = useMemo(() => new Set(installed.map((i) => i.id)), [installed]);

  return { jobs, jobList, installed, installedIds, start, pause, resume, remove, deleteInstalled, openFolder };
}

export type Downloads = ReturnType<typeof useDownloads>;
