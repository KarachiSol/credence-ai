import type { ChatMessage, Memory, Store } from "./db";
import { chat, type Provider } from "./llm";
import { uid } from "./platform";

const MAX_MEMORY_CHARS = 1800;
const STOP = new Set(["with", "that", "this", "have", "from", "about", "what", "your", "when", "where", "which", "there", "would", "could", "should", "please", "help", "kya", "hai", "mein", "aur"]);

/** Memories to put in the system prompt: preferences always, then the most relevant facts. */
export function pickMemories(all: Memory[], latestUserText: string): Memory[] {
  const words = new Set(
    latestUserText
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
  const score = (m: Memory) => {
    const low = m.text.toLowerCase();
    let hits = 0;
    words.forEach((w) => low.includes(w) && hits++);
    const ageDays = (Date.now() - m.lastUsedAt) / 86_400_000;
    return (m.kind === "preference" ? 5 : 0) + hits * 3 + Math.max(0, 2 - ageDays / 30);
  };
  const out: Memory[] = [];
  let used = 0;
  for (const m of [...all].sort((a, b) => score(b) - score(a))) {
    if (used + m.text.length > MAX_MEMORY_CHARS) continue;
    out.push(m);
    used += m.text.length + 3;
  }
  return out;
}

const EXTRACT_PROMPT = `You maintain a memory about the user of a personal assistant.
Read the new conversation lines and the existing memory. Output JSON only, no other text:
{"add": [{"text": "...", "kind": "fact" | "preference"}], "update": [{"id": "...", "text": "..."}], "delete": ["id"]}

Rules:
- Only lasting things about the USER: who they are, work, projects, people, tools they use, likes, how they want answers.
- Not: one-time questions, facts about the world, things the assistant said, secrets like passwords or keys.
- One short third-person sentence each, e.g. "Works as a React developer."
- Update an existing memory instead of adding a near-duplicate. Delete memories the user says are wrong.
- If nothing new, output {"add": [], "update": [], "delete": []}.`;

interface Extraction {
  add?: { text: string; kind?: string }[];
  update?: { id: string; text: string }[];
  delete?: string[];
}

function parseJson(text: string): Extraction | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Extraction;
  } catch {
    return null;
  }
}

/**
 * Reads new messages and updates memory. Runs in the background after a reply.
 * Returns how many memories changed.
 */
export async function extractMemories(opts: {
  provider: Provider;
  store: Store;
  conversationId: string;
  messages: ChatMessage[];
}): Promise<number> {
  const lines = opts.messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.slice(0, 1500)}`)
    .join("\n");
  if (!lines.includes("User:")) return 0;

  const existing = await opts.store.listMemories();
  const memoryText = existing.length ? existing.map((m) => `- (${m.id}) ${m.text}`).join("\n") : "(empty)";
  const result = await chat({
    provider: opts.provider,
    temperature: 0,
    messages: [
      { role: "system", content: EXTRACT_PROMPT },
      { role: "user", content: `Existing memory:\n${memoryText}\n\nNew conversation lines:\n${lines}\n\n/no_think` },
    ],
  });
  const parsed = parseJson(result.content);
  if (!parsed) return 0;

  const now = Date.now();
  const byId = new Map(existing.map((m) => [m.id, m]));
  let changed = 0;
  for (const a of parsed.add ?? []) {
    const text = a.text?.trim();
    if (!text || text.length > 300) continue;
    if (existing.some((m) => m.text.toLowerCase() === text.toLowerCase())) continue;
    await opts.store.saveMemory({
      id: uid(),
      text,
      kind: a.kind === "preference" ? "preference" : "fact",
      sourceConversationId: opts.conversationId,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    });
    changed++;
  }
  for (const u of parsed.update ?? []) {
    const m = byId.get(u.id);
    if (m && u.text?.trim()) {
      await opts.store.saveMemory({ ...m, text: u.text.trim(), updatedAt: now });
      changed++;
    }
  }
  for (const id of parsed.delete ?? []) {
    if (byId.has(id)) {
      await opts.store.deleteMemory(id);
      changed++;
    }
  }
  return changed;
}
