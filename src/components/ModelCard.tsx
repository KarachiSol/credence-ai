import { useId, useState } from "react";
import { isActive, jobId, specFor, type Downloads } from "../lib/downloads";
import type { ModelFit } from "../lib/fit";
import { gb, params, tokPerSec } from "../lib/format";
import { ConfirmDialog } from "./ConfirmDialog";
import { FIT_TEXT, FitBadge } from "./FitBadge";
import { IconCheck, IconChevron, IconDownload, IconPlay, IconWarn } from "./icons";

interface Props {
  item: ModelFit;
  downloads: Downloads;
  /** Opens the Downloads screen. */
  onShowDownloads: () => void;
  /** Opens the My models screen. */
  onShowInstalled: () => void;
}

export function ModelCard({ item, downloads, onShowDownloads, onShowInstalled }: Props) {
  const { model, variantFits } = item;
  const [quant, setQuant] = useState(item.variant.quant);
  const [showWhy, setShowWhy] = useState(false);
  const whyId = useId();
  const current = variantFits.find((v) => v.variant.quant === quant) ?? variantFits[0];
  const { variant, fit } = current;
  const [confirmAnyway, setConfirmAnyway] = useState(false);

  const id = jobId(model.id, variant.quant);
  const job = downloads.jobs.get(id);
  const installed = downloads.installedIds.has(id);
  const startDownload = () => {
    void downloads.start(specFor(model, variant), variant.sizeGB);
  };

  return (
    <article className="@container flex h-full flex-col rounded-2xl border border-zinc-200 bg-white p-4 transition-shadow hover:shadow-sm sm:p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold" title={model.name}>
            {model.name}
          </h3>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {model.publisher} · {params(model.totalParamsB)} params
            {model.kind === "moe" && ` · ${params(model.activeParamsB)} active`}
          </p>
        </div>
        <FitBadge label={fit.label} />
      </header>

      <p className="mt-3 line-clamp-2 min-h-10 text-sm text-zinc-600 dark:text-zinc-300" title={model.description}>
        {model.description}
      </p>

      <p
        className={`mt-3 text-sm font-medium ${
          fit.label === "recommended"
            ? "text-emerald-700 dark:text-emerald-300"
            : fit.label === "slow"
              ? "text-amber-800 dark:text-amber-300"
              : "text-rose-700 dark:text-rose-300"
        }`}
      >
        {fit.reason}
      </p>

      {fit.warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {fit.warnings.map((w) => (
            <li key={w} className="flex gap-1.5 text-xs text-amber-800 dark:text-amber-300">
              <IconWarn width={14} height={14} className="mt-px shrink-0" />
              {w}
            </li>
          ))}
        </ul>
      )}

      <dl className="mt-4 grid grid-cols-3 gap-2 rounded-xl bg-zinc-50 p-3 text-center dark:bg-zinc-800/60">
        <div className="min-w-0">
          <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">Download</dt>
          <dd className="truncate text-sm font-semibold">{gb(variant.sizeGB)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">Memory</dt>
          <dd className="truncate text-sm font-semibold">{gb(fit.ramMinGB)}+</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] text-zinc-500 dark:text-zinc-400">Speed</dt>
          <dd className="truncate text-sm font-semibold">~{tokPerSec(fit.tokPerSec)}</dd>
        </div>
      </dl>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {model.tags.map((t) => (
          <span
            key={t}
            className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
          >
            {t}
          </span>
        ))}
      </div>

      {showWhy && (
        <div
          id={whyId}
          className="mt-3 space-y-1 rounded-xl border border-dashed border-zinc-200 p-3 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
        >
          <p>Memory your computer can give: {gb(fit.memBudgetGB)}</p>
          <p>
            Model needs {gb(fit.ramMinGB)} to start, {gb(fit.ramGoodGB)} to run at full speed
          </p>
          <p>Kept in memory: {Math.round(fit.inMemoryFrac * 100)}% (the rest streams from your SSD)</p>
          <p>Disk space needed: {gb(fit.diskNeededGB)}</p>
          <p className="text-zinc-400 dark:text-zinc-500">Speeds are estimates and get more accurate after your first chat.</p>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2 pt-4">
        {variantFits.length > 1 ? (
          <label className="relative block">
            <span className="sr-only">Version</span>
            <select
              value={quant}
              onChange={(e) => setQuant(e.target.value)}
              className="h-9 w-full appearance-none truncate rounded-lg border border-zinc-200 bg-white pr-8 pl-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              {variantFits.map((v) => (
                <option key={v.variant.quant} value={v.variant.quant}>
                  {v.variant.quant} · {gb(v.variant.sizeGB)} · {FIT_TEXT[v.fit.label]}
                </option>
              ))}
            </select>
            <IconChevron
              width={16}
              height={16}
              className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-zinc-400"
            />
          </label>
        ) : (
          <p className="flex h-9 items-center truncate rounded-lg border border-zinc-200 px-3 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            {variant.quant} · {gb(variant.sizeGB)} · only version
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowWhy((s) => !s)}
            aria-expanded={showWhy}
            aria-controls={whyId}
            className="h-9 shrink-0 rounded-lg border border-zinc-200 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {showWhy ? "Hide details" : "Why?"}
          </button>
          <DownloadButton
            installed={installed}
            active={job ? isActive(job.status) : false}
            progress={job && job.totalBytes ? job.doneBytes / job.totalBytes : 0}
            resumable={job?.status === "paused" || job?.status === "error"}
            noSpace={fit.diskOk === false}
            wontRun={fit.label === "wont-run"}
            onDownload={() => (fit.label === "wont-run" ? setConfirmAnyway(true) : startDownload())}
            onShowDownloads={onShowDownloads}
            onShowInstalled={onShowInstalled}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirmAnyway}
        title="This model will very likely fail"
        confirmText="Download anyway"
        onCancel={() => setConfirmAnyway(false)}
        onConfirm={() => {
          setConfirmAnyway(false);
          startDownload();
        }}
      >
        {fit.reason} It is a {gb(variant.sizeGB)} download. Do you still want to download it?
      </ConfirmDialog>
    </article>
  );
}

const PRIMARY =
  "inline-flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium disabled:cursor-not-allowed";

interface ButtonProps {
  installed: boolean;
  active: boolean;
  progress: number;
  resumable: boolean;
  noSpace: boolean;
  wontRun: boolean;
  onDownload: () => void;
  onShowDownloads: () => void;
  onShowInstalled: () => void;
}

function DownloadButton(p: ButtonProps) {
  if (p.installed) {
    return (
      <button
        type="button"
        onClick={p.onShowInstalled}
        className={`${PRIMARY} border border-emerald-600/25 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-400/25 dark:bg-emerald-500/10 dark:text-emerald-300`}
      >
        <IconCheck width={16} height={16} />
        Installed
      </button>
    );
  }
  if (p.active) {
    return (
      <button
        type="button"
        onClick={p.onShowDownloads}
        className={`${PRIMARY} relative overflow-hidden border border-brand-600/30 text-brand-700 dark:text-brand-400`}
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-brand-50 transition-[width] duration-300 dark:bg-brand-500/15"
          style={{ width: `${Math.round(p.progress * 100)}%` }}
        />
        <span className="relative">Downloading {Math.round(p.progress * 100)}%</span>
      </button>
    );
  }
  if (p.noSpace) {
    return (
      <button type="button" disabled className={`${PRIMARY} bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500`}>
        Not enough space
      </button>
    );
  }
  if (p.resumable) {
    return (
      <button type="button" onClick={p.onDownload} className={`${PRIMARY} bg-brand-600 text-white hover:bg-brand-700`}>
        <IconPlay width={16} height={16} />
        Resume
      </button>
    );
  }
  if (p.wontRun) {
    return (
      <button
        type="button"
        onClick={p.onDownload}
        className={`${PRIMARY} border border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800`}
      >
        Download anyway
      </button>
    );
  }
  return (
    <button type="button" onClick={p.onDownload} className={`${PRIMARY} bg-brand-600 text-white hover:bg-brand-700`}>
      <IconDownload width={16} height={16} />
      Download
    </button>
  );
}
