import type { ToolCall } from "./db";
import { appFetch, uid } from "./platform";

/** OpenAI-style message sent to the model. */
export type LlmMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Provider {
  /** e.g. http://127.0.0.1:8000/v1 */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /**
   * Send tools in the API's `tools` field. False: describe them in the prompt and read calls
   * from the text instead (small Qwen3 models on Colibri, or a server that rejected `tools`).
   */
  nativeTools: boolean;
  demo?: boolean;
}

export interface ChatResult {
  content: string;
  thinking: string;
  toolCalls: ToolCall[];
  tokPerSec?: number;
  ttftMs?: number;
}

export interface StreamOptions {
  provider: Provider;
  messages: LlmMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  signal?: AbortSignal;
  /** Called with the visible text and the thinking text so far. */
  onDelta?: (content: string, thinking: string) => void;
}

/** Splits Qwen-style `<think>…</think>` from the answer. Works on partial text. */
export function splitThinking(raw: string): { content: string; thinking: string } {
  const open = raw.indexOf("<think>");
  if (open === -1) {
    // Some servers drop the opening tag and only send `</think>`.
    const close = raw.indexOf("</think>");
    if (close === -1) return { content: raw, thinking: "" };
    return { thinking: raw.slice(0, close).trim(), content: raw.slice(close + 8).trimStart() };
  }
  const close = raw.indexOf("</think>", open);
  if (close === -1) return { content: raw.slice(0, open), thinking: raw.slice(open + 7) };
  return {
    content: (raw.slice(0, open) + raw.slice(close + 8)).trimStart(),
    thinking: raw.slice(open + 7, close).trim(),
  };
}

const newCall = (name: string, args: unknown): ToolCall => ({
  id: `call_${uid().slice(0, 8)}`,
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
});

/** `{"name": …, "arguments": …}`, the JSON form Qwen3 (0.6B to 32B) was trained on. */
function jsonCall(body: string): ToolCall | null {
  const text = body
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const obj = JSON.parse(text) as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (typeof obj.name === "string" && obj.name) return newCall(obj.name, obj.arguments ?? obj.parameters);
  } catch {
    // Not JSON.
  }
  return null;
}

/** `<function=name><parameter=key>value</parameter></function>`, the XML form of Qwen3.5 / 3.6. */
function xmlCall(body: string): ToolCall | null {
  const fn = /<function=([^>\n]+)>([\s\S]*?)(?:<\/function>|$)/.exec(body);
  if (!fn) return null;
  const args: Record<string, unknown> = {};
  for (const m of fn[2].matchAll(/<parameter=([^>\n]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g)) {
    const raw = m[2].replace(/^\n/, "").replace(/\n$/, "");
    let value: unknown = raw;
    if (/^\s*[[{]/.test(raw) || /^\s*(-?\d+(\.\d+)?|true|false|null)\s*$/.test(raw)) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    args[m[1].trim()] = value;
  }
  return newCall(fn[1].trim(), args);
}

/**
 * Tool calls written as text, used when the server does not return structured calls.
 * Reads Qwen3's JSON form and Qwen3.5/3.6's XML form, also when the model forgot the
 * closing tag (small models often stop right after the call).
 */
export function parseInlineToolCalls(text: string): { content: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  const read = (whole: string, body: string) => {
    const call = jsonCall(body) ?? xmlCall(body);
    if (!call) return whole;
    toolCalls.push(call);
    return "";
  };
  let content = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, read);
  // An unclosed call at the very end.
  content = content.replace(/<tool_call>\s*([\s\S]*)$/, read);
  if (!toolCalls.length) {
    // A bare <function=…> block with no wrapper.
    const bare = /<function=[^>\n]+>[\s\S]*?<\/function>/g;
    content = content.replace(bare, (whole) => read(whole, whole));
  }
  return { content: content.trim(), toolCalls };
}

/** Hides a tool call that is still being written, so raw JSON never flashes in the chat. */
export function hideToolCallText(text: string): string {
  const i = text.indexOf("<tool_call>");
  return i === -1 ? text : text.slice(0, i).trimEnd();
}

/** The `# Tools` system block, word for word as Qwen3's chat template writes it. */
export function toolProtocolPrompt(tools: ToolSchema[]): string {
  return [
    "# Tools",
    "",
    "You may call one or more functions to assist with the user query.",
    "",
    "You are provided with function signatures within <tools></tools> XML tags:",
    "<tools>",
    ...tools.map((t) => JSON.stringify(t)),
    "</tools>",
    "",
    "For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:",
    "<tool_call>",
    '{"name": <function-name>, "arguments": <args-json-object>}',
    "</tool_call>",
  ].join("\n");
}

/**
 * Messages for a server that is not given `tools`: the tool list goes into the system
 * prompt and calls and results are written as text, in the format Qwen3 was trained on.
 * Results that follow each other share one user turn, as in Qwen3's template.
 */
export function withTextTools(messages: LlmMessage[], tools: ToolSchema[]): LlmMessage[] {
  const [first, ...rest] = messages;
  const sys = first?.role === "system" ? first.content : "";
  const out: LlmMessage[] = [{ role: "system", content: sys ? `${sys}\n\n${toolProtocolPrompt(tools)}` : toolProtocolPrompt(tools) }];
  let prevTool = false;
  for (const m of first?.role === "system" ? rest : messages) {
    if (m.role === "tool") {
      const block = `<tool_response>\n${m.content}\n</tool_response>`;
      const last = out[out.length - 1];
      if (prevTool && last.role === "user") last.content += `\n${block}`;
      else out.push({ role: "user", content: block });
      prevTool = true;
      continue;
    }
    prevTool = false;
    if (m.role === "assistant" && m.tool_calls?.length) {
      const calls = m.tool_calls
        .map((t) => `<tool_call>\n{"name": ${JSON.stringify(t.function.name)}, "arguments": ${t.function.arguments || "{}"}}\n</tool_call>`)
        .join("\n");
      out.push({ role: "assistant", content: m.content ? `${m.content}\n${calls}` : calls });
      continue;
    }
    out.push(m);
  }
  return out;
}

class ToolsUnsupported extends Error {}

async function streamOpenAI(o: StreamOptions): Promise<ChatResult> {
  const { provider } = o;
  const started = performance.now();
  let firstTokenAt = 0;
  const body: Record<string, unknown> = {
    model: provider.model,
    messages: o.messages,
    stream: true,
    temperature: o.temperature ?? 0.6,
  };
  if (o.tools?.length && provider.nativeTools) body.tools = o.tools;

  const res = await appFetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: o.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (body.tools && (res.status === 400 || res.status === 422) && /tool/i.test(text)) throw new ToolsUnsupported(text);
    throw new Error(`The model server returned ${res.status}. ${text.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("The model server sent no reply.");

  let raw = "";
  let reasoning = "";
  let answer = "";
  let chunks = 0;
  const calls = new Map<number, ToolCall>();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usageTokens = 0;

  const handle = (data: string) => {
    if (data === "[DONE]") return;
    let evt: {
      choices?: { delta?: { content?: string; reasoning_content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
      usage?: { completion_tokens?: number };
    };
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    if (evt.usage?.completion_tokens) usageTokens = evt.usage.completion_tokens;
    const delta = evt.choices?.[0]?.delta;
    if (!delta) return;
    // Servers either inline `<think>` in content or send `reasoning_content` separately.
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    if (delta.content) answer += delta.content;
    raw = reasoning ? `<think>${reasoning}</think>${answer}` : answer;
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      const cur = calls.get(i) ?? { id: tc.id ?? `call_${uid().slice(0, 8)}`, name: "", arguments: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(i, cur);
    }
    if (delta.content || delta.reasoning_content || delta.tool_calls) {
      chunks++;
      if (!firstTokenAt) firstTokenAt = performance.now();
      const { content, thinking } = splitThinking(raw);
      o.onDelta?.(hideToolCallText(content), thinking);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data:")) handle(line.slice(5).trim());
    }
  }
  if (buffer.trim().startsWith("data:")) handle(buffer.trim().slice(5).trim());

  const split = splitThinking(raw);
  const inline = parseInlineToolCalls(split.content);
  const toolCalls = [...calls.values()].filter((c) => c.name);
  const genSecs = firstTokenAt ? (performance.now() - firstTokenAt) / 1000 : 0;
  const tokens = usageTokens || chunks;
  return {
    content: inline.content,
    thinking: split.thinking,
    toolCalls: toolCalls.length ? toolCalls : inline.toolCalls,
    tokPerSec: genSecs > 0.2 ? tokens / genSecs : undefined,
    ttftMs: firstTokenAt ? Math.round(firstTokenAt - started) : undefined,
  };
}

/**
 * Streams one model reply. With `nativeTools` the server gets `tools`; without it (or after the
 * server rejects them) the tools are described in the prompt and calls are read from the text.
 */
export async function chat(o: StreamOptions): Promise<ChatResult> {
  if (o.provider.demo) return demoChat(o);
  if (o.tools?.length && !o.provider.nativeTools) {
    return streamOpenAI({ ...o, messages: withTextTools(o.messages, o.tools) });
  }
  try {
    return await streamOpenAI(o);
  } catch (e) {
    if (!(e instanceof ToolsUnsupported) || !o.tools) throw e;
    o.provider.nativeTools = false;
    return streamOpenAI({ ...o, messages: withTextTools(o.messages, o.tools) });
  }
}

/** Lists model ids from `/v1/models`. Used as the health check. */
export async function listModels(baseUrl: string, apiKey?: string, signal?: AbortSignal): Promise<string[]> {
  const res = await appFetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal,
  });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id);
}

// ---------------------------------------------------------------------------
// Browser preview: a pretend model so the chat screen can be tried without an engine.

async function demoChat(o: StreamOptions): Promise<ChatResult> {
  const last = o.messages[o.messages.length - 1];
  const userText = [...o.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  let toolCalls: ToolCall[] = [];
  let text: string;
  if (last.role === "tool") {
    text =
      "Here is what I found (demo answer):\n\n- The search tool opened the top results and read them.\n- Sources are listed under this message.\n\n*This is the browser preview. Install the app and start a model for real answers.*";
  } else if (/search|latest|news|today|who is|what is/i.test(userText) && o.tools?.some((t) => t.function.name === "web_search")) {
    text = "";
    toolCalls = [{ id: `call_${uid().slice(0, 8)}`, name: "web_search", arguments: JSON.stringify({ query: userText.slice(0, 80) }) }];
  } else if (/file|note|save/i.test(userText) && o.tools?.some((t) => t.function.name === "create_file")) {
    text = "";
    toolCalls = [
      {
        id: `call_${uid().slice(0, 8)}`,
        name: "create_file",
        arguments: JSON.stringify({ path: "notes/demo.md", content: `# Demo note\n\n${userText}\n` }),
      },
    ];
  } else {
    text = `**Demo reply.** You said: "${userText.slice(0, 120)}"\n\nTry asking me to *search* something or to *save a note* to see tools in action.`;
  }
  const thinking = "The user asked something. In the preview I just pretend to think.";
  let shown = "";
  for (const word of text.split(/(\s+)/)) {
    if (o.signal?.aborted) break;
    shown += word;
    o.onDelta?.(shown, thinking);
    await new Promise((r) => setTimeout(r, 18));
  }
  return { content: shown, thinking, toolCalls, tokPerSec: 42, ttftMs: 180 };
}
