import type { Memory, Source, Store } from "./db";
import type { ToolSchema } from "./llm";
import { invoke, isTauri, uid } from "./platform";
import type { Settings } from "./settings";
import { readPage, relevantExcerpt, search, type SearchResult } from "./web";

export interface PermissionRequest {
  title: string;
  detail?: string;
  /** Text shown in a code box, e.g. the file content. */
  preview?: string;
}

export interface ToolContext {
  settings: Settings;
  store: Store;
  conversationId: string;
  askPermission: (req: PermissionRequest) => Promise<boolean>;
  signal?: AbortSignal;
}

export interface ToolOutput {
  content: string;
  status: "ok" | "error" | "denied";
  sources?: Source[];
}

type Args = Record<string, unknown>;

export interface Tool {
  schema: ToolSchema;
  /** Short line for the chat, e.g. "Searching the web for …". */
  label: (args: Args) => string;
  run: (args: Args, ctx: ToolContext) => Promise<ToolOutput>;
}

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : v == null ? fallback : String(v));
const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSchema => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

const ok = (content: string, sources?: Source[]): ToolOutput => ({ content, status: "ok", sources });
const fail = (content: string): ToolOutput => ({ content: `Error: ${content}`, status: "error" });

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);
}

// ---- Browser preview stand-ins ----
const demoFiles = new Map<string, string>();
const demoResults = (q: string): SearchResult[] => [
  { title: `${q} - Wikipedia`, url: "https://en.wikipedia.org/wiki/Special:Search", snippet: "Demo result. In the desktop app this is a real web search." },
  { title: `Latest on ${q}`, url: "https://news.ycombinator.com/", snippet: "Second demo result with a short snippet." },
  { title: `${q} explained`, url: "https://developer.mozilla.org/", snippet: "Third demo result." },
];

// ---------------------------------------------------------------------------

const webSearch: Tool = {
  schema: fn(
    "web_search",
    "Search the internet. Use it for anything recent, for facts you are not sure about, prices, news, people, products, docs. The top results are opened and read automatically, so you usually get page text back, not only snippets.",
    {
      query: { type: "string", description: "Search words, like you would type into a search engine. Keep it short and specific." },
    },
    ["query"],
  ),
  label: (a) => `Searching the web for "${str(a.query)}"`,
  async run(a, ctx) {
    const query = str(a.query).trim();
    if (!query) return fail("query is empty");
    const { settings } = ctx;
    let results: SearchResult[];
    try {
      results = isTauri()
        ? await search(query, { provider: settings.searchProvider, braveKey: settings.braveKey, limit: 6 })
        : demoResults(query);
    } catch (e) {
      return fail(`search failed: ${String(e)}`);
    }
    if (results.length === 0) return ok(`No results for "${query}". Try other words.`);

    const toRead = isTauri() ? Math.min(Math.max(settings.searchAutoRead, 0), 3) : 0;
    const pages = await Promise.all(
      results.slice(0, toRead).map((r) =>
        withTimeout(readPage(r.url), 12_000)
          .then((p) => relevantExcerpt(p.text, query, 1800))
          .catch(() => ""),
      ),
    );

    const lines = results.map((r, i) => {
      const excerpt = pages[i];
      return [
        `[${i + 1}] ${r.title}`,
        `URL: ${r.url}`,
        r.snippet && `Snippet: ${r.snippet}`,
        excerpt && `Page text:\n${excerpt}`,
      ]
        .filter(Boolean)
        .join("\n");
    });
    return ok(
      `Results for "${query}". Cite sources as [n] in your answer.\n\n${lines.join("\n\n")}`,
      results.map((r) => ({ title: r.title, url: r.url })),
    );
  },
};

const readWebpage: Tool = {
  schema: fn(
    "read_webpage",
    "Open a web page and read its main text. Use after web_search when you need more detail from one result, or when the user gives a link.",
    {
      url: { type: "string", description: "Full http(s) link." },
      focus: { type: "string", description: "Optional: what you are looking for on the page." },
    },
    ["url"],
  ),
  label: (a) => `Reading ${hostOf(str(a.url))}`,
  async run(a) {
    const url = str(a.url).trim();
    if (!/^https?:\/\//.test(url)) return fail("url must start with http:// or https://");
    if (!isTauri()) return ok(`(Preview) Pretend text of ${url}.`, [{ title: hostOf(url), url }]);
    try {
      const page = await withTimeout(readPage(url), 20_000);
      const text = relevantExcerpt(page.text, str(a.focus) || page.title, 7000);
      return ok(`Title: ${page.title}\nURL: ${page.url}\n\n${text || "(no readable text)"}`, [{ title: page.title, url: page.url }]);
    } catch (e) {
      return fail(`could not read ${url}: ${String(e)}`);
    }
  },
};

function hostOf(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const workspaceArgs = (ctx: ToolContext) => ({ root: ctx.settings.workspaceDir || null });

const createFile: Tool = {
  schema: fn(
    "create_file",
    "Create or overwrite a text file (notes, markdown, code, csv…) in the user's Credence workspace folder. The user must approve it.",
    {
      path: { type: "string", description: "Relative path inside the workspace, e.g. notes/shopping.md" },
      content: { type: "string", description: "Full file content." },
      overwrite: { type: "boolean", description: "Replace the file if it exists. Default false." },
    },
    ["path", "content"],
  ),
  label: (a) => `Creating file ${str(a.path)}`,
  async run(a, ctx) {
    const path = str(a.path).trim();
    const content = str(a.content);
    if (!path) return fail("path is empty");
    const allowed = await ctx.askPermission({
      title: `Create ${path}?`,
      detail: a.overwrite ? "This replaces the file if it already exists." : "Saved in your Credence workspace folder.",
      preview: content.length > 4000 ? `${content.slice(0, 4000)}\n…` : content,
    });
    if (!allowed) return { content: "The user did not allow creating this file.", status: "denied" };
    try {
      if (!isTauri()) {
        demoFiles.set(path, content);
        return ok(`Created ${path} (preview, not really saved).`);
      }
      const full = await invoke<string>("workspace_write", { ...workspaceArgs(ctx), path, content, overwrite: Boolean(a.overwrite) });
      return ok(`Created ${path} (${content.length} characters). Full path: ${full}`);
    } catch (e) {
      return fail(String(e));
    }
  },
};

const readFile: Tool = {
  schema: fn(
    "read_file",
    "Read a text file from the user's Credence workspace folder.",
    { path: { type: "string", description: "Relative path inside the workspace." } },
    ["path"],
  ),
  label: (a) => `Reading file ${str(a.path)}`,
  async run(a, ctx) {
    const path = str(a.path).trim();
    try {
      if (!isTauri()) return demoFiles.has(path) ? ok(demoFiles.get(path)!) : fail(`${path} not found`);
      const text = await invoke<string>("workspace_read", { ...workspaceArgs(ctx), path });
      return ok(text.length > 20_000 ? `${text.slice(0, 20_000)}\n…(cut, file is longer)` : text);
    } catch (e) {
      return fail(String(e));
    }
  },
};

const listFiles: Tool = {
  schema: fn(
    "list_files",
    "List files and folders in the user's Credence workspace folder.",
    { path: { type: "string", description: "Sub folder, empty for the top level." } },
    [],
  ),
  label: (a) => (str(a.path) ? `Looking in ${str(a.path)}` : "Looking at your workspace files"),
  async run(a, ctx) {
    try {
      if (!isTauri()) return ok([...demoFiles.keys()].join("\n") || "(empty)");
      const entries = await invoke<{ path: string; isDir: boolean; size: number }[]>("workspace_list", {
        ...workspaceArgs(ctx),
        path: str(a.path),
      });
      return ok(entries.map((e) => (e.isDir ? `${e.path}/` : `${e.path} (${e.size} bytes)`)).join("\n") || "(empty)");
    } catch (e) {
      return fail(String(e));
    }
  },
};

const remember: Tool = {
  schema: fn(
    "remember",
    "Save a lasting fact or preference about the user so you know it in future chats (e.g. their job, projects, likes, how they want answers). Not for one-off details.",
    {
      fact: { type: "string", description: "One short sentence in third person, e.g. 'Prefers answers in Roman Urdu.'" },
      kind: { type: "string", enum: ["fact", "preference"] },
    },
    ["fact"],
  ),
  label: () => "Saving to memory",
  async run(a, ctx) {
    const text = str(a.fact).trim();
    if (!text) return fail("fact is empty");
    if (!ctx.settings.memoryEnabled) return ok("Memory is turned off by the user. Nothing saved.");
    const now = Date.now();
    const m: Memory = {
      id: uid(),
      text,
      kind: a.kind === "preference" ? "preference" : "fact",
      sourceConversationId: ctx.conversationId,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    };
    await ctx.store.saveMemory(m);
    return ok(`Saved to memory: ${text}`);
  },
};

const forget: Tool = {
  schema: fn(
    "forget",
    "Delete a saved memory when the user asks you to forget something or it is no longer true.",
    { about: { type: "string", description: "Words describing the memory to delete." } },
    ["about"],
  ),
  label: () => "Updating memory",
  async run(a, ctx) {
    const words = str(a.about).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const mems = await ctx.store.listMemories();
    const scored = mems
      .map((m) => ({ m, score: words.filter((w) => m.text.toLowerCase().includes(w)).length }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score);
    if (!scored.length) return ok("No matching memory found.");
    await ctx.store.deleteMemory(scored[0].m.id);
    return ok(`Forgot: ${scored[0].m.text}`);
  },
};

const currentTime: Tool = {
  schema: fn("get_current_time", "Get the current date, time and time zone of the user.", {}, []),
  label: () => "Checking the time",
  async run() {
    const now = new Date();
    return ok(
      `${now.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
    );
  },
};

export const TOOLS: Tool[] = [webSearch, readWebpage, createFile, readFile, listFiles, remember, forget, currentTime];
export const toolByName = (name: string) => TOOLS.find((t) => t.schema.function.name === name);

export function parseArgs(json: string): Args {
  try {
    const v = JSON.parse(json || "{}");
    return v && typeof v === "object" ? (v as Args) : {};
  } catch {
    return {};
  }
}
