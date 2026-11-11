import type { ChatMessage, Memory, Source, Store } from "./db";
import { chat, type LlmMessage, type Provider } from "./llm";
import { pickMemories } from "./memory";
import { uid } from "./platform";
import type { Settings } from "./settings";
import { parseArgs, toolByName, TOOLS, type PermissionRequest } from "./tools";

const MAX_STEPS = 8;
const MAX_HISTORY = 40;

export function systemPrompt(memories: Memory[], settings: Settings): string {
  const now = new Date();
  const parts = [
    `You are Credence, a personal AI assistant that runs fully on the user's own computer. Today is ${now.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`,
    "Be helpful, direct and friendly. Answer in the language the user writes in (for example Roman Urdu if they write Roman Urdu). Use markdown for lists, tables and code.",
    "",
    "How to work:",
    "- For anything recent, factual, or that you are not sure about, call web_search first. Then answer from the results and cite them as [1], [2]. Do not invent sources. If the results are thin, search again with different words or read_webpage a result.",
    "- To save something for the user (notes, drafts, code, lists), use create_file. Files go into the user's Credence workspace folder.",
    "- When the user tells you a lasting fact about themselves or how they like answers, call remember. If they ask you to forget something, call forget.",
    "- Call tools only when they help. For simple chat, just answer.",
  ];
  if (settings.memoryEnabled && memories.length) {
    parts.push("", "What you know about the user (from earlier chats):", ...memories.map((m) => `- ${m.text}`));
  }
  return parts.join("\n");
}

/** Turns stored messages into what the model sees. Old tool results are shortened to save context. */
export function toLlmMessages(history: ChatMessage[]): LlmMessage[] {
  const recent = history.slice(-MAX_HISTORY);
  // Never start with a tool result whose call was cut off.
  while (recent.length && recent[0].role === "tool") recent.shift();
  const lastUser = recent.map((m) => m.role).lastIndexOf("user");
  return recent.map((m, i): LlmMessage => {
    if (m.role === "tool") {
      const old = i < lastUser;
      return {
        role: "tool",
        tool_call_id: m.toolCallId ?? "",
        name: m.toolName,
        content: old && m.content.length > 1500 ? `${m.content.slice(0, 1500)}\n…(shortened)` : m.content,
      };
    }
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: t.arguments } })) }
          : {}),
      };
    }
    return { role: "user", content: m.content };
  });
}

export interface RunOptions {
  provider: Provider;
  store: Store;
  settings: Settings;
  conversationId: string;
  history: ChatMessage[];
  askPermission: (req: PermissionRequest) => Promise<boolean>;
  signal: AbortSignal;
  /** Called for every new or changed message (streaming text included). */
  onMessage: (m: ChatMessage) => void;
}

/** The agent loop: model → tools → model … until it answers without tools. */
export async function runAgent(o: RunOptions): Promise<void> {
  const memories = o.settings.memoryEnabled ? await o.store.listMemories() : [];
  const lastUser = [...o.history].reverse().find((m) => m.role === "user")?.content ?? "";
  const picked = pickMemories(memories, lastUser);
  if (picked.length) void o.store.touchMemories(picked.map((m) => m.id), Date.now());

  const history = [...o.history];
  const tools = TOOLS.map((t) => t.schema);

  for (let step = 0; step < MAX_STEPS; step++) {
    if (o.signal.aborted) return;
    const draft: ChatMessage = {
      id: uid(),
      conversationId: o.conversationId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      meta: { model: o.provider.model },
    };
    o.onMessage(draft);

    let result;
    try {
      result = await chat({
        provider: o.provider,
        temperature: o.settings.temperature,
        tools,
        signal: o.signal,
        messages: [{ role: "system", content: systemPrompt(picked, o.settings) }, ...toLlmMessages(history)],
        onDelta: (content, thinking) => o.onMessage({ ...draft, content, meta: { ...draft.meta, thinking } }),
      });
    } catch (e) {
      if (o.signal.aborted) {
        // Keep whatever was streamed so far.
        return;
      }
      const failed = { ...draft, content: `⚠️ ${e instanceof Error ? e.message : String(e)}` };
      o.onMessage(failed);
      await o.store.saveMessage(failed);
      return;
    }

    const assistant: ChatMessage = {
      ...draft,
      content: result.content,
      toolCalls: result.toolCalls.length ? result.toolCalls : undefined,
      meta: {
        ...draft.meta,
        thinking: result.thinking || undefined,
        tokPerSec: result.tokPerSec,
        ttftMs: result.ttftMs,
      },
    };
    o.onMessage(assistant);
    await o.store.saveMessage(assistant);
    history.push(assistant);

    if (!result.toolCalls.length) return;

    const sources: Source[] = [];
    for (const call of result.toolCalls) {
      if (o.signal.aborted) return;
      const tool = toolByName(call.name);
      const out = tool
        ? await tool
            .run(parseArgs(call.arguments), {
              settings: o.settings,
              store: o.store,
              conversationId: o.conversationId,
              askPermission: o.askPermission,
              signal: o.signal,
            })
            .catch((e: unknown) => ({ content: `Error: ${String(e)}`, status: "error" as const, sources: undefined }))
        : { content: `Error: there is no tool named ${call.name}.`, status: "error" as const, sources: undefined };
      if (out.sources) sources.push(...out.sources);
      const toolMsg: ChatMessage = {
        id: uid(),
        conversationId: o.conversationId,
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: out.content,
        createdAt: Date.now(),
        meta: { toolStatus: out.status, sources: out.sources },
      };
      o.onMessage(toolMsg);
      await o.store.saveMessage(toolMsg);
      history.push(toolMsg);
    }
  }
  const stop: ChatMessage = {
    id: uid(),
    conversationId: o.conversationId,
    role: "assistant",
    content: "I stopped after several tool steps. Ask me to continue if you need more.",
    createdAt: Date.now(),
  };
  o.onMessage(stop);
  await o.store.saveMessage(stop);
}
