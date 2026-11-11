# Credence AI: Agent and Memory Roadmap

| | |
|---|---|
| Status | Draft, after MVP |
| Date | 2026-11-11 |
| Depends on | `docs/mvp-requirements-and-hardware-model-fit.md` (MVP: download, engine, chat) |

> **Short summary (Roman Urdu):** Credence ko personal assistant banane ka plan. Model ko train nahi karenge. App apni local memory banayegi jo har model (local ya baad me cloud) ke saath kaam karegi. Phir tools add honge (files, reminders, web), har kaam user ki permission se.

## 1. Goal

Credence becomes a personal assistant that:

1. **Learns the user over time** (preferences, projects, people, writing style).
2. **Keeps that knowledge no matter which model is used** (any local model now, cloud models much later).
3. **Does tasks**, not only chat, always with the user's permission.
4. **Keeps everything on the user's machine.**

## 2. Key decision: memory, not training

| Approach | Verdict |
|---|---|
| Fine-tune the model on the user's chats | **No.** Too slow on consumer PCs, needs lots of RAM/GPU, can damage the model, and is lost when the user switches model. |
| App-owned memory (facts + searchable chat history) injected into the prompt | **Yes.** Works with every model, cheap, the user can see and edit it, survives model changes. |

"Learning" = the memory gets richer and more accurate over time, plus the assistant adapts its style from saved preferences.

## 3. Architecture

```text
            ┌──────────── Credence app (local) ────────────┐
 User ─────►│ Chat UI ─► Agent loop ─► Model provider       │
            │              │   ▲         (Colibri now,       │
            │              │   │          cloud later)       │
            │              ▼   │                             │
            │          Tools (with permission)               │
            │              │                                 │
            │          Memory store (SQLite + embeddings)    │
            └───────────────────────────────────────────────┘
```

- **Model provider interface:** one TypeScript/Rust interface (`chat(messages, tools) → stream`). Colibri's OpenAI-compatible server is the first provider. A cloud provider (OpenAI-compatible or Anthropic API) plugs in later without touching memory or tools.
- **Memory store:** local SQLite, next to chats.
- **Agent loop:** model answers or asks for a tool → app asks the user if needed → runs tool → gives the result back to the model → repeats until done (max steps limit).

## 4. Memory design

### 4.1 Kinds of memory

| Kind | Example | How it is created |
|---|---|---|
| **Profile facts** | "Works as a React developer", "Prefers answers in Roman Urdu" | Extracted after each chat |
| **Preferences / instructions** | "Keep answers short", "Use Tailwind v4" | Extracted, or the user says "remember this" |
| **Episodes** | "On 10 Nov discussed auto-update for Credence" | Short summary per conversation |
| **Chat history search** | Old messages | Embedded and searchable |

### 4.2 Loop

1. **After a chat** (in the background, when the model is idle): ask the model to list new or changed facts as JSON. Merge with existing facts (update, don't duplicate). Each fact keeps `source_conversation_id`, `created_at`, `last_used_at`, `confidence`.
2. **Before each reply:** pick the relevant memories (profile facts always, others by similarity to the new message) within a token budget, and put them in the system prompt.
3. **Decay:** facts not used for a long time rank lower. Contradicted facts are replaced, the old one is kept in history.

### 4.3 User control (must have)

- "What Credence knows about me" screen: list, edit, delete, pause memory.
- "Forget this chat" and "Don't remember this" buttons.
- Memory export / delete all.
- Memory never leaves the machine (and later, never sent to a cloud provider unless the user turns that on).

### 4.4 Embeddings

Need a small local embedding model for search. Open question: does Colibri serve embeddings (`/v1/embeddings`)? If not, ship a tiny embedding model (about 100 MB) or start with keyword search (SQLite FTS5) first, which needs nothing extra.

## 5. Tools (agent actions)

Start small and safe, add more later.

| Phase | Tool | Permission |
|---|---|---|
| A | Remember / forget (memory tools) | None (user can undo) |
| A | Read a file or folder the user picks | Ask once per folder |
| A | Notes and to-dos inside Credence | None |
| A | Reminders (OS notifications) | None |
| B | Web search + read page | Ask per search, can switch to "always allow" |
| B | Write / create files | Ask every time, show diff |
| C | Run commands, control apps, email / calendar | Ask every time, off by default |

Rules: every tool call is shown in the chat ("Credence wants to read `notes.md` · Allow / Deny"), and there is an activity log.

## 6. Model requirements

- Tool calling works with Qwen3 models. Small models (1.7B, 4B) are weak agents. Recommend **8B or larger** (e.g. Qwen3 8B, Qwen3 Coder 30B A3B, Qwen3.6 35B A3B) for agent mode.
- The fit score gets a second dimension later: "good for agent mode" (model capability + speed ≥ ~8 tok/s, because agent loops make several calls).
- Open question: does `coli serve` accept the OpenAI `tools` parameter? If not, use a JSON tool-call prompt format and parse the reply.

## 7. Phases

| Phase | What | Needs |
|---|---|---|
| 0 (MVP) | Download, engine, chat | In progress |
| 1 | Memory: extraction, injection, "What Credence knows" screen, keyword search | Phase 0 |
| 2 | Tools A + agent loop + permission UI | Phase 1 |
| 3 | Embedding search, episodes, smarter recall | Embeddings decision |
| 4 | Tools B and C | Phase 2 stable |
| 5 | Cloud model providers (memory stays local, user chooses what is sent) | Accounts / API keys, much later |

## 8. Open questions

1. Does `coli serve` support the `tools` parameter and `/v1/embeddings`?
2. Should memory extraction run after every chat, or only when the app is idle (it uses the model and slows the PC)?
3. One memory for the whole app, or separate "spaces" (work / personal)?
4. Which tools matter most to the first users?
