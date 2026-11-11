const GB = 1024 ** 3;

export function gb(n: number): string {
  if (n >= 1000) return `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} TB`;
  if (n >= 10) return `${Math.round(n)} GB`;
  return `${n.toFixed(1)} GB`;
}

export const bytesToGb = (bytes: number) => gb(bytes / GB);

export function params(b: number): string {
  return b >= 1 ? `${b % 1 === 0 ? b : b.toFixed(1)}B` : `${Math.round(b * 1000)}M`;
}

export function tokPerSec(n: number): string {
  if (n >= 10) return `${Math.round(n)} tok/s`;
  return `${n.toFixed(1)} tok/s`;
}

export function bytes(n: number): string {
  if (n >= GB) return gb(n / GB);
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function speed(bytesPerSec: number): string {
  return `${bytes(bytesPerSec)}/s`;
}

export function timeLeft(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return "less than a minute left";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min left`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min left`;
}

export function date(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
