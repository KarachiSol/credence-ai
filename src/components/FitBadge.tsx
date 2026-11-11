import type { FitLabel } from "../lib/types";
import { IconBan, IconCheck, IconClock } from "./icons";

export const FIT_TEXT: Record<FitLabel, string> = {
  recommended: "Recommended",
  slow: "Will run slowly",
  "wont-run": "Won't run",
};

const STYLE: Record<FitLabel, string> = {
  recommended:
    "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/25",
  slow: "bg-amber-50 text-amber-800 ring-amber-600/25 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/25",
  "wont-run": "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/25",
};

const ICON = { recommended: IconCheck, slow: IconClock, "wont-run": IconBan } as const;

export function FitBadge({ label }: { label: FitLabel }) {
  const Icon = ICON[label];
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${STYLE[label]}`}
    >
      <Icon width={14} height={14} strokeWidth={2.25} />
      {FIT_TEXT[label]}
    </span>
  );
}
