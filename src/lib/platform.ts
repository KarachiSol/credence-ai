import { invoke, isTauri } from "@tauri-apps/api/core";

export { invoke, isTauri };

/** fetch that works for localhost model servers inside the desktop app (no CORS limits). */
export async function appFetch(input: string, init?: RequestInit): Promise<Response> {
  if (isTauri()) {
    const { fetch } = await import("@tauri-apps/plugin-http");
    return fetch(input, init);
  }
  return fetch(input, init);
}

export interface WebPage {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
}

/** Fetches a web page through Rust (desktop) or the browser (preview, may hit CORS). */
export async function webFetch(
  url: string,
  opts: { form?: [string, string][]; headers?: [string, string][] } = {},
): Promise<WebPage> {
  if (isTauri()) return invoke<WebPage>("web_fetch", { url, form: opts.form ?? null, headers: opts.headers ?? null });
  const res = await fetch(url, {
    method: opts.form ? "POST" : "GET",
    headers: Object.fromEntries(opts.headers ?? []),
    body: opts.form ? new URLSearchParams(opts.form) : undefined,
  });
  return { status: res.status, finalUrl: res.url, contentType: res.headers.get("content-type") ?? "", body: await res.text() };
}

export const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Opens a link in the default browser (desktop) or a new tab (preview). */
export async function openUrl(url: string) {
  if (isTauri()) await invoke("open_url", { url });
  else window.open(url, "_blank", "noopener");
}
