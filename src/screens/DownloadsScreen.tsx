import { ProgressBar } from "../components/ProgressBar";
import { IconClose, IconDownload, IconPause, IconPlay } from "../components/icons";
import { isActive, type Downloads, type Job } from "../lib/downloads";
import { bytes, speed, timeLeft } from "../lib/format";

const STATUS_TEXT: Record<Job["status"], string> = {
  queued: "Starting…",
  downloading: "Downloading",
  paused: "Paused",
  verifying: "Checking file…",
  done: "Installed",
  error: "Failed",
};

function JobRow({ job, downloads }: { job: Job; downloads: Downloads }) {
  const frac = job.totalBytes ? job.doneBytes / job.totalBytes : 0;
  const active = isActive(job.status);
  const tone = job.status === "error" ? "rose" : job.status === "paused" ? "amber" : job.status === "done" ? "emerald" : "brand";
  const left = job.bytesPerSec ? timeLeft((job.totalBytes - job.doneBytes) / job.bytesPerSec) : "";

  const iconBtn =
    "grid size-9 shrink-0 place-items-center rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

  return (
    <li className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{job.spec.name}</p>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {job.spec.quant} · {STATUS_TEXT[job.status]}
          </p>
        </div>
        <div className="flex gap-2">
          {active && job.status !== "verifying" && (
            <button type="button" aria-label="Pause" title="Pause" className={iconBtn} onClick={() => downloads.pause(job.id)}>
              <IconPause width={16} height={16} />
            </button>
          )}
          {(job.status === "paused" || job.status === "error") && (
            <button type="button" aria-label="Resume" title="Resume" className={iconBtn} onClick={() => downloads.resume(job)}>
              <IconPlay width={16} height={16} />
            </button>
          )}
          {job.status !== "done" && job.status !== "verifying" && (
            <button
              type="button"
              aria-label="Cancel download"
              title="Cancel and delete"
              className={iconBtn}
              onClick={() => downloads.remove(job.id)}
            >
              <IconClose width={16} height={16} />
            </button>
          )}
        </div>
      </div>

      {job.status !== "done" && (
        <div className="mt-4">
          <ProgressBar value={frac} tone={tone} />
          <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            <span>
              {job.totalBytes ? `${bytes(job.doneBytes)} of ${bytes(job.totalBytes)}` : "Getting file list…"}
            </span>
            {job.status === "downloading" && job.bytesPerSec > 0 && (
              <span>
                {speed(job.bytesPerSec)}
                {left && ` · ${left}`}
              </span>
            )}
          </div>
        </div>
      )}

      {job.error && (
        <p className="mt-3 rounded-lg bg-rose-50 p-2.5 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          {job.error}
        </p>
      )}
    </li>
  );
}

export function DownloadsScreen({ downloads, onBrowse }: { downloads: Downloads; onBrowse: () => void }) {
  const jobs = downloads.jobList.filter((j) => j.status !== "done");
  const finished = downloads.jobList.filter((j) => j.status === "done");

  if (downloads.jobList.length === 0) {
    return (
      <div className="grid h-full place-items-center px-4 py-10">
        <div className="max-w-sm text-center">
          <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400">
            <IconDownload />
          </div>
          <h2 className="mt-4 text-lg font-semibold">No downloads yet</h2>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Pick a model that fits your computer and download it.</p>
          <button
            type="button"
            onClick={onBrowse}
            className="mt-5 h-9 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
          >
            Browse models
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      {jobs.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">In progress</h2>
          <ul className="flex flex-col gap-3">
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} downloads={downloads} />
            ))}
          </ul>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Downloads continue where they stopped, even after you close the app.
          </p>
        </section>
      )}
      {finished.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">Finished</h2>
          <ul className="flex flex-col gap-3">
            {finished.map((j) => (
              <JobRow key={j.id} job={j} downloads={downloads} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
