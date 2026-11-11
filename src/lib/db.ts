import { isTauri } from "./platform";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON string, as the model produced it. */
  arguments: string;
}

export interface Source {
  title: string;
  url: string;
}

export interface MessageMeta {
  tokPerSec?: number;
  ttftMs?: number;
  thinking?: string;
  sources?: Source[];
  /** Tool result state. */
  toolStatus?: "ok" | "error" | "denied";
  model?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  meta?: MessageMeta;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  /** Messages already sent to memory extraction. */
  memoryCursor: number;
}

export interface Memory {
  id: string;
  text: string;
  kind: "fact" | "preference";
  sourceConversationId: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
}

export interface Store {
  listConversations(): Promise<Conversation[]>;
  saveConversation(c: Conversation): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  listMessages(conversationId: string): Promise<ChatMessage[]>;
  saveMessage(m: ChatMessage): Promise<void>;
  listMemories(): Promise<Memory[]>;
  saveMemory(m: Memory): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  touchMemories(ids: string[], at: number): Promise<void>;
  clearMemories(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SQLite (desktop). The file lives in the app's data folder and never leaves the machine.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, memory_cursor INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
    tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, meta TEXT, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL, source_conversation_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL)`,
];

type Row = Record<string, unknown>;
const json = <T,>(v: unknown): T | undefined => (typeof v === "string" && v ? (JSON.parse(v) as T) : undefined);

async function sqliteStore(): Promise<Store> {
  const { default: Database } = await import("@tauri-apps/plugin-sql");
  const db = await Database.load("sqlite:credence.db");
  for (const sql of SCHEMA) await db.execute(sql);

  const toConv = (r: Row): Conversation => ({
    id: r.id as string,
    title: r.title as string,
    model: r.model as string,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    memoryCursor: Number(r.memory_cursor),
  });
  const toMsg = (r: Row): ChatMessage => ({
    id: r.id as string,
    conversationId: r.conversation_id as string,
    role: r.role as ChatMessage["role"],
    content: r.content as string,
    toolCalls: json<ToolCall[]>(r.tool_calls),
    toolCallId: (r.tool_call_id as string) || undefined,
    toolName: (r.tool_name as string) || undefined,
    meta: json<MessageMeta>(r.meta),
    createdAt: Number(r.created_at),
  });
  const toMem = (r: Row): Memory => ({
    id: r.id as string,
    text: r.text as string,
    kind: r.kind as Memory["kind"],
    sourceConversationId: (r.source_conversation_id as string) || null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastUsedAt: Number(r.last_used_at),
  });

  return {
    async listConversations() {
      return (await db.select<Row[]>("SELECT * FROM conversations ORDER BY updated_at DESC")).map(toConv);
    },
    async saveConversation(c) {
      await db.execute(
        `INSERT INTO conversations (id, title, model, created_at, updated_at, memory_cursor) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT(id) DO UPDATE SET title=$2, model=$3, updated_at=$5, memory_cursor=$6`,
        [c.id, c.title, c.model, c.createdAt, c.updatedAt, c.memoryCursor],
      );
    },
    async deleteConversation(id) {
      await db.execute("DELETE FROM messages WHERE conversation_id=$1", [id]);
      await db.execute("DELETE FROM conversations WHERE id=$1", [id]);
    },
    async listMessages(conversationId) {
      return (
        await db.select<Row[]>("SELECT * FROM messages WHERE conversation_id=$1 ORDER BY created_at, rowid", [conversationId])
      ).map(toMsg);
    },
    async saveMessage(m) {
      await db.execute(
        `INSERT INTO messages (id, conversation_id, role, content, tool_calls, tool_call_id, tool_name, meta, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT(id) DO UPDATE SET content=$4, tool_calls=$5, meta=$8`,
        [
          m.id,
          m.conversationId,
          m.role,
          m.content,
          m.toolCalls ? JSON.stringify(m.toolCalls) : null,
          m.toolCallId ?? null,
          m.toolName ?? null,
          m.meta ? JSON.stringify(m.meta) : null,
          m.createdAt,
        ],
      );
    },
    async listMemories() {
      return (await db.select<Row[]>("SELECT * FROM memories ORDER BY updated_at DESC")).map(toMem);
    },
    async saveMemory(m) {
      await db.execute(
        `INSERT INTO memories (id, text, kind, source_conversation_id, created_at, updated_at, last_used_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(id) DO UPDATE SET text=$2, kind=$3, updated_at=$6, last_used_at=$7`,
        [m.id, m.text, m.kind, m.sourceConversationId, m.createdAt, m.updatedAt, m.lastUsedAt],
      );
    },
    async deleteMemory(id) {
      await db.execute("DELETE FROM memories WHERE id=$1", [id]);
    },
    async touchMemories(ids, at) {
      for (const id of ids) await db.execute("UPDATE memories SET last_used_at=$1 WHERE id=$2", [at, id]);
    },
    async clearMemories() {
      await db.execute("DELETE FROM memories");
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory store for the browser preview.

export function memoryStore(): Store {
  const convs = new Map<string, Conversation>();
  const msgs = new Map<string, ChatMessage>();
  const mems = new Map<string, Memory>();
  return {
    async listConversations() {
      return [...convs.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async saveConversation(c) {
      convs.set(c.id, { ...c });
    },
    async deleteConversation(id) {
      convs.delete(id);
      for (const [k, m] of msgs) if (m.conversationId === id) msgs.delete(k);
    },
    async listMessages(conversationId) {
      return [...msgs.values()].filter((m) => m.conversationId === conversationId).sort((a, b) => a.createdAt - b.createdAt);
    },
    async saveMessage(m) {
      msgs.set(m.id, { ...m });
    },
    async listMemories() {
      return [...mems.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async saveMemory(m) {
      mems.set(m.id, { ...m });
    },
    async deleteMemory(id) {
      mems.delete(id);
    },
    async touchMemories(ids, at) {
      for (const id of ids) {
        const m = mems.get(id);
        if (m) mems.set(id, { ...m, lastUsedAt: at });
      }
    },
    async clearMemories() {
      mems.clear();
    },
  };
}

let storePromise: Promise<Store> | null = null;
export function getStore(): Promise<Store> {
  storePromise ??= isTauri() ? sqliteStore() : Promise.resolve(memoryStore());
  return storePromise;
}
