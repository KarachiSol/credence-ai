import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Markdown } from "../components/Markdown";
import {
  IconBrain,
  IconCheck,
  IconChevron,
  IconClose,
  IconFile,
  IconGlobe,
  IconLink,
  IconMenu,
  IconPlus,
  IconSend,
  IconSpinner,
  IconStop,
  IconTrash,
  IconWarn,
} from "../components/icons";
import { runAgent } from "../lib/agent";
import { getStore, type ChatMessage, type Conversation, type Source, type Store } from "../lib/db";
import type { Downloads } from "../lib/downloads";
import type { Engine } from "../lib/engine";
import { tokPerSec } from "../lib/format";
import { extractMemories } from "../lib/memory";
import { openUrl, uid } from "../lib/platform";
import type { Settings } from "../lib/settings";
import { parseArgs, toolByName, type PermissionRequest } from "../lib/tools";

interface Props {
  settings: Settings;
  engine: Engine;
  downloads: Downloads;
  onOpenSettings: () => void;
  onBrowseModels: () => void;
  onMemoryChanged: () => void;
}

interface PendingPermission {
  req: PermissionRequest;
  resolve: (ok: boolean) => void;
}

/** Extract memories after this many new user messages. */
const MEMORY_EVERY = 2;

export function ChatScreen({ settings, engine, downloads, onOpenSettings, onBrowseModels, onMemoryChanged }: Props) {
  const [store, setStore] = useState<Store | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Conversation | null>(null);
  const [memoryNote, setMemoryNote] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    void getStore().then(async (s) => {
      setStore(s);
      setConversations(await s.listConversations());
    });
  }, []);

  const openConversation = useCallback(
    async (c: Conversation | null) => {
      if (!store || busy) return;
      setActive(c);
      setMessages(c ? await store.listMessages(c.id) : []);
      setListOpen(false);
      stick.current = true;
    },
    [store, busy],
  );

  // Keep the view pinned to the bottom while streaming, unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, permission]);

  const upsert = useCallback((m: ChatMessage) => {
    setMessages((list) => {
      const i = list.findIndex((x) => x.id === m.id);
      if (i === -1) return [...list, m];
      const next = list.slice();
      next[i] = m;
      return next;
    });
  }, []);

  const askPermission = useCallback(
    (req: PermissionRequest) => new Promise<boolean>((resolve) => setPermission({ req, resolve })),
    [],
  );

  const ready = engine.info.state === "ready" && engine.info.provider;

  const updateMemory = useCallback(
    async (conv: Conversation, all: ChatMessage[], force: boolean) => {
      if (!store || !settings.memoryEnabled || !engine.info.provider) return;
      const fresh = all.slice(conv.memoryCursor);
      const newUser = fresh.filter((m) => m.role === "user").length;
      if (newUser === 0 || (!force && newUser < MEMORY_EVERY)) return;
      const saved = { ...conv, memoryCursor: all.length };
      await store.saveConversation(saved);
      setActive((a) => (a?.id === conv.id ? saved : a));
      try {
        const n = await extractMemories({ provider: engine.info.provider, store, conversationId: conv.id, messages: fresh });
        if (n > 0) {
          setMemoryNote(`Memory updated (${n})`);
          onMemoryChanged();
          setTimeout(() => setMemoryNote(null), 4000);
        }
      } catch {
        // Memory is best effort. The chat itself already worked.
      }
    },
    [store, settings.memoryEnabled, engine.info.provider, onMemoryChanged],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !store || busy || !ready || !engine.info.provider) return;
    setInput("");
    stick.current = true;

    let conv = active;
    const now = Date.now();
    if (!conv) {
      conv = { id: uid(), title: text.slice(0, 60), model: engine.info.label, createdAt: now, updatedAt: now, memoryCursor: 0 };
      await store.saveConversation(conv);
      setActive(conv);
    }
    const userMsg: ChatMessage = { id: uid(), conversationId: conv.id, role: "user", content: text, createdAt: now };
    await store.saveMessage(userMsg);
    const history = [...messages, userMsg];
    setMessages(history);

    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    const produced: ChatMessage[] = [];
    try {
      await runAgent({
        provider: engine.info.provider,
        store,
        settings,
        conversationId: conv.id,
        history,
        askPermission,
        signal: ctrl.signal,
        onMessage: (m) => {
          const i = produced.findIndex((x) => x.id === m.id);
          if (i === -1) produced.push(m);
          else produced[i] = m;
          upsert(m);
        },
      });
    } finally {
      // Save a reply that was stopped half way.
      if (ctrl.signal.aborted) {
        for (const m of produced) if (m.role === "assistant" && m.content) await store.saveMessage(m);
      }
      setBusy(false);
      setPermission(null);
      abort.current = null;
      const updated = { ...conv, updatedAt: Date.now(), model: engine.info.label };
      await store.saveConversation(updated);
      setConversations(await store.listConversations());
      void updateMemory(updated, [...history, ...produced.filter((m) => m.content || m.toolCalls)], false);
    }
  }, [input, store, busy, ready, engine.info, active, messages, settings, askPermission, upsert, updateMemory]);

  const stop = () => {
    abort.current?.abort();
    permission?.resolve(false);
  };

  const newChat = async () => {
    if (active) void updateMemory(active, messages, true);
    await openConversation(null);
  };

  const deleteConversation = async (c: Conversation) => {
    if (!store) return;
    await store.deleteConversation(c.id);
    setConversations(await store.listConversations());
    if (active?.id === c.id) await openConversation(null);
  };

  const list = (
    <ConversationList
      conversations={conversations}
      activeId={active?.id ?? null}
      onNew={newChat}
      onOpen={openConversation}
      onDelete={setToDelete}
      disabled={busy}
    />
  );

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-zinc-200 bg-white lg:flex dark:border-zinc-800 dark:bg-zinc-900">
        {list}
      </aside>

      {listOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Chats">
          <button type="button" aria-label="Close chats" className="absolute inset-0 bg-zinc-950/40" onClick={() => setListOpen(false)} />
          <div className="relative flex h-full w-72 max-w-[85vw] flex-col bg-white shadow-xl dark:bg-zinc-900">{list}</div>
        </div>
      )}

      <section className="flex min-w-0 flex-1 flex-col">
        <EngineBar
          engine={engine}
          downloads={downloads}
          settings={settings}
          onShowList={() => setListOpen(true)}
          onOpenSettings={onOpenSettings}
        />

        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
            {!ready && messages.length === 0 && (
              <EngineSetup
                engine={engine}
                downloads={downloads}
                settings={settings}
                onOpenSettings={onOpenSettings}
                onBrowseModels={onBrowseModels}
              />
            )}
            {ready && messages.length === 0 && <EmptyChat onPick={(t) => setInput(t)} />}
            <MessageList messages={messages} busy={busy} />
            {permission && (
              <PermissionCard
                req={permission.req}
                onAnswer={(ok) => {
                  permission.resolve(ok);
                  setPermission(null);
                }}
              />
            )}
          </div>
        </div>

        <Composer
          value={input}
          onChange={setInput}
          onSend={send}
          onStop={stop}
          busy={busy}
          disabled={!ready}
          note={memoryNote}
        />
      </section>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this chat?"
        confirmText="Delete"
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) void deleteConversation(toDelete);
          setToDelete(null);
        }}
      >
        “{toDelete?.title}” will be removed from this computer. Things Credence remembered from it stay in Memory.
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ConversationList(p: {
  conversations: Conversation[];
  activeId: string | null;
  onNew: () => void;
  onOpen: (c: Conversation) => void;
  onDelete: (c: Conversation) => void;
  disabled: boolean;
}) {
  return (
    <>
      <div className="p-3">
        <button
          type="button"
          onClick={p.onNew}
          disabled={p.disabled}
          className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <IconPlus width={16} height={16} />
          New chat
        </button>
      </div>
      <nav aria-label="Chats" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {p.conversations.length === 0 && <p className="px-3 py-2 text-xs text-zinc-400 dark:text-zinc-500">No chats yet.</p>}
        {p.conversations.map((c) => {
          const on = c.id === p.activeId;
          return (
            <div
              key={c.id}
              className={`group flex items-center rounded-lg ${on ? "bg-zinc-100 dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"}`}
            >
              <button
                type="button"
                disabled={p.disabled}
                onClick={() => p.onOpen(c)}
                aria-current={on ? "true" : undefined}
                className="min-w-0 flex-1 truncate px-3 py-2 text-left text-sm text-zinc-700 disabled:cursor-not-allowed dark:text-zinc-200"
              >
                {c.title || "New chat"}
              </button>
              <button
                type="button"
                aria-label={`Delete ${c.title}`}
                onClick={() => p.onDelete(c)}
                className="mr-1 grid size-7 shrink-0 place-items-center rounded-md text-zinc-400 opacity-100 hover:bg-zinc-200 hover:text-rose-600 lg:opacity-0 lg:group-hover:opacity-100 lg:focus:opacity-100 dark:hover:bg-zinc-700"
              >
                <IconTrash width={14} height={14} />
              </button>
            </div>
          );
        })}
      </nav>
      <p className="border-t border-zinc-200 px-4 py-3 text-[11px] text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
        Chats are saved only on this computer.
      </p>
    </>
  );
}

const DOT = { off: "bg-zinc-400", starting: "bg-amber-500 animate-pulse", ready: "bg-emerald-500", error: "bg-rose-500" };

function EngineBar(p: { engine: Engine; downloads: Downloads; settings: Settings; onShowList: () => void; onOpenSettings: () => void }) {
  const { info } = p.engine;
  const text =
    info.state === "ready"
      ? info.label
      : info.state === "starting"
        ? `Loading ${info.label}…`
        : info.state === "error"
          ? "Engine error"
          : "No model running";
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200 bg-white px-3 sm:px-4 dark:border-zinc-800 dark:bg-zinc-900">
      <button
        type="button"
        aria-label="Show chats"
        onClick={p.onShowList}
        className="grid size-8 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 lg:hidden dark:hover:bg-zinc-800"
      >
        <IconMenu width={18} height={18} />
      </button>
      <span className={`size-2 shrink-0 rounded-full ${DOT[info.state]}`} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={text}>
        {text}
      </span>
      {(info.state === "ready" || info.state === "starting") && (
        <button
          type="button"
          onClick={() => void p.engine.stop()}
          className="h-8 shrink-0 rounded-lg border border-zinc-200 px-2.5 text-xs font-medium text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {info.state === "starting" ? "Cancel" : "Stop model"}
        </button>
      )}
    </div>
  );
}

function EngineSetup(p: {
  engine: Engine;
  downloads: Downloads;
  settings: Settings;
  onOpenSettings: () => void;
  onBrowseModels: () => void;
}) {
  const { info } = p.engine;
  const custom = p.settings.engineMode === "custom";
  const btn = "h-9 shrink-0 rounded-lg bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50";
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold">{custom ? "Connect to your model server" : "Start a model to chat"}</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {custom
          ? `Credence will talk to ${p.settings.customUrl}. Change it in Settings.`
          : "Pick one of your downloaded models. The first start can take a few minutes while Colibri prepares it."}
      </p>

      {info.state === "error" && (
        <div className="mt-4 rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          <p className="font-medium">{info.error}</p>
          {info.logs.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs">Engine log</summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-white/70 p-2 font-mono text-[11px] whitespace-pre-wrap text-zinc-700 dark:bg-black/30 dark:text-zinc-300">
                {info.logs.slice(-60).join("\n")}
              </pre>
            </details>
          )}
        </div>
      )}

      {custom ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={btn} disabled={info.state === "starting"} onClick={() => void p.engine.connectCustom()}>
            {info.state === "starting" ? "Connecting…" : "Connect"}
          </button>
          <button
            type="button"
            onClick={p.onOpenSettings}
            className="h-9 rounded-lg border border-zinc-200 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Settings
          </button>
        </div>
      ) : p.downloads.installed.length === 0 ? (
        <button type="button" className={`${btn} mt-4`} onClick={p.onBrowseModels}>
          Download a model first
        </button>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {p.downloads.installed.map((m) => {
            const loading = info.state === "starting" && info.installedId === m.id;
            return (
              <li
                key={m.id}
                className="flex items-center gap-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{m.name}</p>
                  <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{m.quant}</p>
                </div>
                <button type="button" className={btn} disabled={info.state === "starting"} onClick={() => void p.engine.start(m)}>
                  {loading ? (
                    <span className="inline-flex items-center gap-1.5">
                      <IconSpinner width={14} height={14} /> Starting…
                    </span>
                  ) : (
                    "Start"
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!custom && !p.settings.colibriDir && (
        <p className="mt-4 flex gap-2 text-xs text-amber-800 dark:text-amber-300">
          <IconWarn width={14} height={14} className="mt-px shrink-0" />
          <span>
            Set the Colibri folder in{" "}
            <button type="button" onClick={p.onOpenSettings} className="font-medium underline underline-offset-2">
              Settings
            </button>{" "}
            first, or connect to a model server you already run.
          </span>
        </p>
      )}
    </div>
  );
}

const SUGGESTIONS = [
  "Search the latest news about AI on laptops and summarise it",
  "Make a weekly study plan and save it as a file",
  "Remember that I prefer short answers",
  "Explain how SSD streaming lets big models run on small PCs",
];

function EmptyChat({ onPick }: { onPick: (t: string) => void }) {
  return (
    <div className="py-6 text-center sm:py-10">
      <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400">
        <IconBrain />
      </div>
      <h2 className="mt-4 text-xl font-semibold tracking-tight">How can I help?</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">I can search the web, save files and remember what matters to you.</p>
      <div className="mt-6 grid grid-cols-1 gap-2 text-left sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-xl border border-zinc-200 bg-white p-3 text-sm text-zinc-700 hover:border-brand-400 hover:bg-brand-50/40 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-brand-500/50"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function MessageList({ messages, busy }: { messages: ChatMessage[]; busy: boolean }) {
  const results = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const m of messages) if (m.role === "tool" && m.toolCallId) map.set(m.toolCallId, m);
    return map;
  }, [messages]);

  // Sources found by tools since the last user message go under the final answer.
  const sourcesFor = useMemo(() => {
    const map = new Map<string, Source[]>();
    let pending: Source[] = [];
    for (const m of messages) {
      if (m.role === "user") pending = [];
      else if (m.role === "tool" && m.meta?.sources) pending.push(...m.meta.sources);
      else if (m.role === "assistant" && !m.toolCalls?.length && pending.length) {
        const seen = new Set<string>();
        map.set(
          m.id,
          pending.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true))),
        );
        pending = [];
      }
    }
    return map;
  }, [messages]);

  const last = messages[messages.length - 1];
  return (
    <>
      {messages.map((m) => {
        if (m.role === "tool") return null;
        if (m.role === "user") {
          return (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-white">
                {m.content}
              </div>
            </div>
          );
        }
        const streaming = busy && m.id === last?.id;
        return (
          <AssistantMessage key={m.id} m={m} results={results} sources={sourcesFor.get(m.id)} streaming={streaming} busy={busy} />
        );
      })}
    </>
  );
}

function AssistantMessage(p: {
  m: ChatMessage;
  results: Map<string, ChatMessage>;
  sources?: Source[];
  streaming: boolean;
  busy: boolean;
}) {
  const { m } = p;
  const thinking = m.meta?.thinking;
  const empty = !m.content && !m.toolCalls?.length;
  return (
    <div className="flex flex-col gap-2">
      {thinking && (
        <details className="group rounded-xl border border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">
            <IconChevron width={14} height={14} className="-rotate-90 transition-transform group-open:rotate-0" />
            {p.streaming && !m.content ? "Thinking…" : "Thoughts"}
          </summary>
          <p className="mt-2 text-xs leading-relaxed whitespace-pre-wrap text-zinc-500 dark:text-zinc-400">{thinking}</p>
        </details>
      )}

      {m.content ? (
        <Markdown text={m.content} />
      ) : (
        empty &&
        p.streaming &&
        !thinking && (
          <span className="inline-flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <IconSpinner width={14} height={14} /> Working…
          </span>
        )
      )}

      {m.toolCalls?.map((call) => (
        <ToolCard key={call.id} name={call.name} args={call.arguments} result={p.results.get(call.id)} running={p.busy} />
      ))}

      {p.sources && p.sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {p.sources.slice(0, 8).map((s, i) => (
            <button
              key={s.url}
              type="button"
              onClick={() => void openUrl(s.url)}
              title={s.url}
              className="inline-flex max-w-60 items-center gap-1.5 rounded-full border border-zinc-200 bg-white py-1 pr-2.5 pl-1.5 text-xs text-zinc-600 hover:border-brand-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            >
              <span className="grid size-4 shrink-0 place-items-center rounded-full bg-zinc-100 text-[10px] font-semibold dark:bg-zinc-800">
                {i + 1}
              </span>
              <span className="truncate">{s.title || hostname(s.url)}</span>
            </button>
          ))}
        </div>
      )}

      {!p.streaming && m.meta?.tokPerSec && (
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
          {tokPerSec(m.meta.tokPerSec)}
          {m.meta.ttftMs ? ` · first word after ${(m.meta.ttftMs / 1000).toFixed(1)} s` : ""}
        </p>
      )}
    </div>
  );
}

function hostname(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const TOOL_ICON: Record<string, (p: { width: number; height: number }) => ReactNode> = {
  web_search: (p) => <IconGlobe {...p} />,
  read_webpage: (p) => <IconLink {...p} />,
  create_file: (p) => <IconFile {...p} />,
  read_file: (p) => <IconFile {...p} />,
  list_files: (p) => <IconFile {...p} />,
  remember: (p) => <IconBrain {...p} />,
  forget: (p) => <IconBrain {...p} />,
};

function ToolCard(p: { name: string; args: string; result?: ChatMessage; running: boolean }) {
  const tool = toolByName(p.name);
  const label = tool ? tool.label(parseArgs(p.args)) : `Using ${p.name}`;
  const status = p.result?.meta?.toolStatus ?? (p.result ? "ok" : p.running ? "running" : "error");
  const icon = TOOL_ICON[p.name]?.({ width: 15, height: 15 }) ?? <IconCheck width={15} height={15} />;
  return (
    <details className="group rounded-xl border border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/60">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-white text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-700 dark:text-zinc-200">{label}</span>
        {status === "running" && <IconSpinner width={14} height={14} className="text-zinc-400" />}
        {status === "ok" && <IconCheck width={14} height={14} className="text-emerald-600 dark:text-emerald-400" />}
        {status === "error" && <IconWarn width={14} height={14} className="text-rose-600 dark:text-rose-400" />}
        {status === "denied" && <IconClose width={14} height={14} className="text-zinc-400" />}
        <IconChevron width={14} height={14} className="shrink-0 text-zinc-400 transition-transform group-open:rotate-180" />
      </summary>
      {p.result && (
        <pre className="max-h-64 overflow-auto border-t border-zinc-200 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          {p.result.content}
        </pre>
      )}
    </details>
  );
}

function PermissionCard({ req, onAnswer }: { req: PermissionRequest; onAnswer: (ok: boolean) => void }) {
  return (
    <div role="alertdialog" aria-label={req.title} className="rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/40 dark:bg-amber-500/10">
      <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">{req.title}</p>
      {req.detail && <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">{req.detail}</p>}
      {req.preview && (
        <pre className="mt-3 max-h-56 overflow-auto rounded-lg bg-white p-3 font-mono text-[12px] whitespace-pre-wrap text-zinc-700 ring-1 ring-amber-200 dark:bg-zinc-950 dark:text-zinc-300 dark:ring-amber-500/20">
          {req.preview}
        </pre>
      )}
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => onAnswer(true)} className="h-9 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">
          Allow
        </button>
        <button
          type="button"
          onClick={() => onAnswer(false)}
          className="h-9 rounded-lg border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function Composer(p: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  disabled: boolean;
  note: string | null;
}) {
  return (
    <div className="shrink-0 border-t border-zinc-200 bg-white/90 px-3 pt-3 pb-3 backdrop-blur sm:px-4 dark:border-zinc-800 dark:bg-zinc-900/90">
      <form
        className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border border-zinc-200 bg-white p-2 shadow-sm focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/15 dark:border-zinc-700 dark:bg-zinc-900"
        onSubmit={(e) => {
          e.preventDefault();
          p.onSend();
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">Message</span>
          <textarea
            value={p.value}
            onChange={(e) => p.onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!p.busy) p.onSend();
              }
            }}
            rows={1}
            placeholder={p.disabled ? "Start a model to chat…" : "Message Credence"}
            className="field-sizing-content max-h-48 min-h-9 w-full resize-none bg-transparent px-2 py-1.5 text-[15px] leading-6 placeholder:text-zinc-400 focus:outline-none"
          />
        </label>
        {p.busy ? (
          <button
            type="button"
            onClick={p.onStop}
            aria-label="Stop"
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
          >
            <IconStop width={16} height={16} />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            disabled={p.disabled || !p.value.trim()}
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-40"
          >
            <IconSend width={18} height={18} />
          </button>
        )}
      </form>
      <p className="mx-auto mt-1.5 max-w-3xl text-center text-[11px] text-zinc-400 dark:text-zinc-500">
        {p.note ?? "Runs on your computer. Answers can be wrong, check important facts."}
      </p>
    </div>
  );
}
