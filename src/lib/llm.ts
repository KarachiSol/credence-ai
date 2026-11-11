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
  /** Set to false after the server rejects the `tools` field. */
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

/** Qwen's own text format for tool calls, used when the server does not return structured calls. */
export function parseInlineToolCalls(text: string): { content: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];
  const content = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_, body: string) => {
    try {
      const obj = JSON.parse(body) as { name?: string; arguments?: unknown };
      if (obj.name) {
        toolCalls.push({
          id: `call_${uid().slice(0, 8)}`,
          name: obj.name,
          arguments: typeof obj.arguments === "string" ? obj.arguments : JSON.stringify(obj.arguments ?? {}),
        });
        return "";
      }
    } catch {
      // Not valid JSON: leave it in the text.
    }
    return _;
  });
  return { content: content.trim(), toolCalls };
}

export function toolProtocolPrompt(tools: ToolSchema[]): string {
  return [
    "# Tools",
    "You can call these tools. To call one, reply with exactly:",
    '<tool_call>\n{"name": "tool_name", "arguments": {"arg": "value"}}\n</tool_call>',
    "Then wait for the result. Available tools:",
    ...tools.map((t) => JSON.stringify(t.function)),
  ].join("\n");
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
      o.onDelta?.(content, thinking);
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

/** Streams one model reply. Falls back to text tool calls if the server rejects `tools`. */
export async function chat(o: StreamOptions): Promise<ChatResult> {
  if (o.provider.demo) return demoChat(o);
  try {
    return await streamOpenAI(o);
  } catch (e) {
    if (!(e instanceof ToolsUnsupported) || !o.tools) throw e;
    o.provider.nativeTools = false;
    const [first, ...rest] = o.messages;
    const sys = first?.role === "system" ? first.content : "";
    const messages: LlmMessage[] = [
      { role: "system", content: `${sys}\n\n${toolProtocolPrompt(o.tools)}` },
      ...(first?.role === "system" ? rest : o.messages).map((m): LlmMessage =>
        m.role === "tool"
          ? { role: "user", content: `<tool_response>\n${m.content}\n</tool_response>` }
          : m.role === "assistant" && m.tool_calls?.length
            ? {
                role: "assistant",
                content: `${m.content}\n${m.tool_calls.map((t) => `<tool_call>\n{"name": "${t.function.name}", "arguments": ${t.function.arguments || "{}"}}\n</tool_call>`).join("\n")}`,
              }
            : m,
      ),
    ];
    return streamOpenAI({ ...o, messages });
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
