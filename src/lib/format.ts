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
