import { describe, expect, it } from "vitest";
import { asksForSearch, searchQueryFrom, toLlmMessages } from "./agent";
import type { ChatMessage, Memory } from "./db";
import { hideToolCallText, parseInlineToolCalls, splitThinking, withTextTools } from "./llm";
import { pickMemories } from "./memory";
import { relevantExcerpt } from "./web";

const msg = (p: Partial<ChatMessage>): ChatMessage => ({
  id: Math.random().toString(36),
  conversationId: "c",
  role: "user",
  content: "",
  createdAt: 0,
  ...p,
});

describe("splitThinking", () => {
  it("separates closed think blocks", () => {
    expect(splitThinking("<think>hmm</think>Hello")).toEqual({ thinking: "hmm", content: "Hello" });
  });
  it("handles a block still streaming", () => {
    expect(splitThinking("<think>still going")).toEqual({ thinking: "still going", content: "" });
  });
  it("handles servers that drop the opening tag", () => {
    expect(splitThinking("plan</think>Answer")).toEqual({ thinking: "plan", content: "Answer" });
  });
  it("leaves normal text alone", () => {
    expect(splitThinking("Just text")).toEqual({ thinking: "", content: "Just text" });
  });
});

describe("parseInlineToolCalls", () => {
  it("reads Qwen tool call tags", () => {
    const r = parseInlineToolCalls('Let me check.\n<tool_call>\n{"name": "web_search", "arguments": {"query": "colibri"}}\n</tool_call>');
    expect(r.content).toBe("Let me check.");
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].name).toBe("web_search");
    expect(JSON.parse(r.toolCalls[0].arguments)).toEqual({ query: "colibri" });
  });
  it("keeps broken JSON as text", () => {
    const r = parseInlineToolCalls("<tool_call>{oops</tool_call>");
    expect(r.toolCalls).toHaveLength(0);
    expect(r.content).toContain("oops");
  });
});

describe("toLlmMessages", () => {
  it("maps tool calls and results", () => {
    const out = toLlmMessages([
      msg({ role: "user", content: "hi" }),
      msg({ role: "assistant", content: "", toolCalls: [{ id: "1", name: "web_search", arguments: "{}" }] }),
      msg({ role: "tool", toolCallId: "1", toolName: "web_search", content: "results" }),
      msg({ role: "assistant", content: "done" }),
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(out[1]).toMatchObject({ tool_calls: [{ id: "1", type: "function", function: { name: "web_search" } }] });
  });
  it("shortens old tool results but not the latest", () => {
    const long = "x".repeat(5000);
    const out = toLlmMessages([
      msg({ role: "user", content: "q1" }),
      msg({ role: "assistant", toolCalls: [{ id: "a", name: "web_search", arguments: "{}" }] }),
      msg({ role: "tool", toolCallId: "a", content: long }),
      msg({ role: "user", content: "q2" }),
      msg({ role: "assistant", toolCalls: [{ id: "b", name: "web_search", arguments: "{}" }] }),
      msg({ role: "tool", toolCallId: "b", content: long }),
    ]);
    expect(out[2].content.length).toBeLessThan(2000);
    expect(out[5].content.length).toBe(5000);
  });
});

describe("pickMemories", () => {
  const mem = (text: string, kind: Memory["kind"] = "fact"): Memory => ({
    id: text,
    text,
    kind,
    sourceConversationId: null,
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: Date.now(),
  });
  it("puts preferences and matching facts first", () => {
    const picked = pickMemories([mem("Has a cat named Billo."), mem("Prefers short answers.", "preference"), mem("Works with React and Tailwind.")], "help with react");
    expect(picked[0].text).toBe("Prefers short answers.");
    expect(picked[1].text).toBe("Works with React and Tailwind.");
  });
  it("respects the size budget", () => {
    const many = Array.from({ length: 200 }, (_, i) => mem(`Fact number ${i} about something fairly long here.`));
    const total = pickMemories(many, "x").reduce((n, m) => n + m.text.length, 0);
    expect(total).toBeLessThanOrEqual(1800);
  });
});

describe("relevantExcerpt", () => {
  it("keeps paragraphs about the question", () => {
    const text = ["Intro about the site.", ...Array.from({ length: 50 }, (_, i) => `Filler paragraph ${i} with nothing useful in it at all.`), "Colibri streams experts from the NVMe SSD."].join("\n");
    const out = relevantExcerpt(text, "how does colibri use the ssd", 400);
    expect(out).toContain("Colibri streams experts");
    expect(out.length).toBeLessThanOrEqual(420);
  });
});

describe("text tool calls from small models", () => {
  it("reads the XML form of Qwen3.5 / 3.6", () => {
    const r = parseInlineToolCalls("<tool_call>\n<function=web_search>\n<parameter=query>\nlahore weather\n</parameter>\n</function>\n</tool_call>");
    expect(r.toolCalls).toHaveLength(1);
    expect(JSON.parse(r.toolCalls[0].arguments)).toEqual({ query: "lahore weather" });
    expect(r.content).toBe("");
  });
  it("reads a call whose closing tag never came", () => {
    const r = parseInlineToolCalls('Sure.\n<tool_call>\n{"name": "web_search", "arguments": {"query": "gold price"}}');
    expect(r.toolCalls.map((c) => c.name)).toEqual(["web_search"]);
    expect(r.content).toBe("Sure.");
  });
  it("hides a call while it streams", () => {
    expect(hideToolCallText('Checking.\n<tool_call>\n{"name": "web_')).toBe("Checking.");
  });
  it("writes tools, calls and results in Qwen3's own format", () => {
    const tools = [{ type: "function" as const, function: { name: "web_search", description: "Search", parameters: {} } }];
    const out = withTextTools(
      [
        { role: "system", content: "You are Credence." },
        { role: "user", content: "news?" },
        { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "web_search", arguments: '{"query":"news"}' } }] },
        { role: "tool", tool_call_id: "1", content: "r1" },
        { role: "tool", tool_call_id: "2", content: "r2" },
      ],
      tools,
    );
    expect(out[0].content).toContain("You are Credence.");
    expect(out[0].content).toContain("<tools>");
    expect(out[2].content).toBe('<tool_call>\n{"name": "web_search", "arguments": {"query":"news"}}\n</tool_call>');
    expect(out).toHaveLength(4);
    expect(out[3]).toEqual({ role: "user", content: "<tool_response>\nr1\n</tool_response>\n<tool_response>\nr2\n</tool_response>" });
  });
});

describe("search requests", () => {
  it("spots a plain ask for a web search", () => {
    expect(asksForSearch("web search kro aaj ka gold rate")).toBe(true);
    expect(asksForSearch("Search the web for Tauri 2 updater docs")).toBe(true);
    expect(asksForSearch("google kro Karachi weather")).toBe(true);
    expect(asksForSearch("Write a poem about rain")).toBe(false);
    expect(asksForSearch("ye code check kro")).toBe(false);
  });
  it("turns the message into a short query", () => {
    expect(searchQueryFrom("web search kro aaj ka gold rate")).toBe("aaj ka gold rate");
    expect(searchQueryFrom("Lahore ka mausam google kro")).toBe("Lahore ka mausam");
    expect(searchQueryFrom("Search the web for Tauri 2 updater docs")).toBe("Tauri 2 updater docs");
  });
});
