import { webFetch } from "./platform";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const decode = (s: string) => {
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
};

function ddgTarget(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const real = u.searchParams.get("uddg");
    return real ? decodeURIComponent(real) : u.href;
  } catch {
    return href;
  }
}

async function duckduckgo(query: string, limit: number): Promise<SearchResult[]> {
  const page = await webFetch("https://html.duckduckgo.com/html/", { form: [["q", query], ["kl", "wt-wt"]] });
  const doc = new DOMParser().parseFromString(page.body, "text/html");
  let results: SearchResult[] = [...doc.querySelectorAll(".result")]
    .filter((r) => !r.classList.contains("result--ad"))
    .map((r) => {
      const a = r.querySelector<HTMLAnchorElement>("a.result__a");
      return {
        title: decode(a?.textContent?.trim() ?? ""),
        url: ddgTarget(a?.getAttribute("href") ?? ""),
        snippet: decode(r.querySelector(".result__snippet")?.textContent?.trim() ?? ""),
      };
    });

  if (results.length === 0) {
    // Lite version as a fallback (different markup).
    const lite = await webFetch("https://lite.duckduckgo.com/lite/", { form: [["q", query]] });
    const ldoc = new DOMParser().parseFromString(lite.body, "text/html");
    const links = [...ldoc.querySelectorAll<HTMLAnchorElement>("a.result-link")];
    const snippets = [...ldoc.querySelectorAll("td.result-snippet")];
    results = links.map((a, i) => ({
      title: a.textContent?.trim() ?? "",
      url: ddgTarget(a.getAttribute("href") ?? ""),
      snippet: snippets[i]?.textContent?.trim() ?? "",
    }));
  }
  return results.filter((r) => r.url.startsWith("http") && !r.url.includes("duckduckgo.com/y.js")).slice(0, limit);
}

async function brave(query: string, limit: number, key: string): Promise<SearchResult[]> {
  const page = await webFetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    { headers: [["Accept", "application/json"], ["X-Subscription-Token", key]] },
  );
  if (page.status !== 200) throw new Error(`Brave Search returned ${page.status}. Check the API key in Settings.`);
  const data = JSON.parse(page.body) as { web?: { results?: { title: string; url: string; description: string }[] } };
  const strip = (s: string) => s.replace(/<[^>]+>/g, "");
  return (data.web?.results ?? []).slice(0, limit).map((r) => ({
    title: strip(r.title),
    url: r.url,
    snippet: decode(strip(r.description ?? "")),
  }));
}

export async function search(
  query: string,
  opts: { limit?: number; provider: "duckduckgo" | "brave"; braveKey?: string },
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 6;
  if (opts.provider === "brave" && opts.braveKey) return brave(query, limit, opts.braveKey);
  return duckduckgo(query, limit);
}

export interface PageText {
  url: string;
  title: string;
  text: string;
}

const DROP = "script,style,noscript,svg,iframe,nav,header,footer,aside,form,button,[role=navigation],[aria-hidden=true],.ad,.ads,.cookie,.newsletter";

/** Readable text of a page: main content only, no menus or scripts. */
export async function readPage(url: string): Promise<PageText> {
  const page = await webFetch(url);
  if (page.status >= 400) throw new Error(`The page returned error ${page.status}.`);
  if (!/html|text\/plain|json|xml/i.test(page.contentType) && page.contentType) {
    throw new Error(`Can't read this kind of file (${page.contentType.split(";")[0]}).`);
  }
  if (/text\/plain|json/i.test(page.contentType)) {
    return { url: page.finalUrl, title: url, text: page.body.slice(0, 40_000) };
  }
  const doc = new DOMParser().parseFromString(page.body, "text/html");
  const title = doc.querySelector("meta[property='og:title']")?.getAttribute("content") || doc.title || url;
  doc.querySelectorAll(DROP).forEach((n) => n.remove());
  const root =
    doc.querySelector("article") ??
    doc.querySelector("main") ??
    doc.querySelector("[role=main]") ??
    doc.querySelector("#content, .content, #main") ??
    doc.body;
  const blocks = [...(root?.querySelectorAll("h1,h2,h3,h4,p,li,pre,blockquote,td,th,dt,dd") ?? [])]
    .map((el) => {
      const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!t) return "";
      if (/^H[1-4]$/.test(el.tagName)) return `\n## ${t}`;
      if (el.tagName === "LI") return `- ${t}`;
      return t;
    })
    .filter((t) => t.length > 1);
  // Drop exact duplicates (nested lists repeat text).
  const seen = new Set<string>();
  const text = blocks.filter((b) => (seen.has(b) ? false : (seen.add(b), true))).join("\n");
  return { url: page.finalUrl, title: decode(title.trim()), text: text || (root?.textContent ?? "").replace(/\s+/g, " ").trim() };
}

/** Picks the paragraphs that best match the question, in page order, within `maxChars`. */
export function relevantExcerpt(text: string, query: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
  const paras = text.split("\n").filter((p) => p.trim());
  const scored = paras.map((p, i) => {
    const low = p.toLowerCase();
    const hits = terms.reduce((n, t) => n + (low.includes(t) ? 1 : 0), 0);
    // Early paragraphs usually hold the summary.
    return { i, p, score: hits * 2 + (i < 5 ? 1.5 : 0) + Math.min(p.length, 400) / 400 };
  });
  const picked = new Set<number>();
  let used = 0;
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (used + s.p.length > maxChars) continue;
    picked.add(s.i);
    used += s.p.length + 1;
  }
  return scored
    .filter((s) => picked.has(s.i))
    .map((s) => s.p)
    .join("\n");
}
