# Credence AI: MVP Requirements and Hardware Model Fit

| | |
|---|---|
| Status | Draft for review |
| Date | 2026-11-10 |
| Scope | First installable version (MVP) of the Credence AI desktop app |
| Related | `credence-ai-context.md` (original vision, in project files) |

> **Short summary (Roman Urdu):** MVP me login nahi hoga. User app install karega, app khulegi, Colibri engine tayyar hoga, Hugging Face se models ki list bina token ke aayegi. App user ka hardware (CPU, RAM, GPU, SSD) check karke har model par label lagayegi: **Recommended**, **Will run slowly**, ya **Won't run**. Recommended models list me sab se upar honge. User model download karke apni machine par chalayega. Chats aur Hugging Face token sirf user ki machine par rahenge. Login (Google, Apple, email) baad wale phase me aayega.

---

## 1. Goal

A non-technical user installs one app, picks a model that their computer can actually run, downloads it, and chats with it locally. The app must stop users from wasting time and disk on models their machine cannot run.

### Success criteria for the MVP

1. A new user goes from "app installed" to "first reply from a local model" without opening a terminal.
2. Every model in the list shows a fit label and a one-line reason (for example "Needs 20 GB RAM, you have 14 GB free").
3. A model marked **Recommended** actually starts and generates at the speed band we promised on at least 80% of test machines.
4. No chat text, prompt, or token ever leaves the user's machine (except model downloads from Hugging Face).

---

## 2. Decisions already made

| Topic | Decision |
|---|---|
| Accounts / login | Planned (Google, Apple, email) but **not in the MVP**. The MVP has no login. See section 9. |
| Chats | Stored **only locally** on the user's machine. Never on our server. |
| Hugging Face token | **Optional.** Stored locally in the OS keychain. Never sent to our server. |
| Model list | Comes from the public Hugging Face API, **no token needed**. |
| Engine | Colibri, bundled with the app. |
| Stack | Tauri (Rust) + React + TypeScript. Tailwind CSS v4 for styling. |
| UI quality | Responsive and pixel perfect across window sizes (see section 7). |

---

## 3. What we learned about Colibri (affects the whole design)

Source: the Colibri README at <https://github.com/JustVugg/colibri> (checked 2026-11-10). These points must be re-checked against the exact Colibri version we bundle.

1. **Colibri does not run every Hugging Face model.** It has engines for specific architectures (Qwen3.6 family, Qwen3-Coder, GLM-5.x, DeepSeek V4 Flash, Kimi K3, MiMo, OLMoE and a few others). A model only works if its architecture is supported. Llama is not listed.
2. **Two model formats:** converted "colibri containers" (published on Hugging Face, e.g. `Justvugg/GLM-5.3-colibri-int4-g64`) and **GGUF files** of a supported architecture, which `coli import` reads directly without re-quantizing.
3. **Colibri publishes two RAM numbers per model:** below the first the model **does not start**; from the second it **runs at the measured speed**. Example: Qwen3.6-35B-A3B is 10 GB / 20 GB with a 23 GB download. This is the best input for our fit score.
4. **Big models stream from disk.** Colibri keeps the core of a Mixture-of-Experts (MoE) model in RAM and reads experts from the SSD. So a 167 GB model can run with 16 GB RAM, but the **SSD speed sets the token speed**.
5. **Built-in helpers:** `coli plan --model <dir>` says where the model will live (VRAM, RAM, disk). `coli tune --model <dir>` measures and saves the fastest safe settings for this machine.
6. **Server mode:** `coli serve --model <dir>` gives OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/models`) on `http://127.0.0.1:8000/v1`. Our app can talk to this instead of parsing terminal output.
7. **GPU backends:** CPU everywhere; Vulkan for AMD, Intel, NVIDIA; CUDA for NVIDIA; Metal on Apple Silicon for some engines.
8. **Small models do exist, but only Qwen3 ones.** Colibri's GGUF importer accepts the `qwen3` (Qwen3 dense) architecture, and its docs benchmark Qwen3-0.6B. So small Qwen3 GGUFs (0.6B, 1.7B, 4B, 8B, roughly 0.5 GB to 5 GB in Q4) should run on almost any machine. Popular small models of other families (Llama 3.2, Gemma, Phi) are **not** supported (their architecture is not in Colibri's list in `docs/gguf.md`), so they cannot appear in our list. The big catalog models (MoE, streamed from SSD) are 14 GB to 500 GB+. Minimum Colibri machine: 8 GB RAM, 16 GB+ better.

**Consequence:** the MVP model list must be filtered to models Colibri can run. Showing every Hugging Face model would show mostly "Won't run".

---

## 4. MVP user flow

```text
Install app ─► Open app ─► Welcome + hardware scan ─► Engine check (Colibri)
     ─► Models screen (Recommended on top, every model labelled)
     ─► Pick model ─► Pick variant (quantization) ─► Disk check ─► Download
     ─► Verify + import ─► Load model (Colibri serve) ─► Chat
```

### Step by step

1. **Install.** Native installer: `.exe`/`.msi` (Windows), `.dmg` (macOS), `.deb`/`.AppImage` (Linux). Colibri binary is bundled as a Tauri sidecar.
2. **First open.** Welcome screen. App runs the hardware scan (section 5.1) in under 3 seconds and shows the result as a simple card ("Your computer: Ryzen 7 7840U, 32 GB RAM (21 GB free), Radeon 780M, NVMe SSD with 410 GB free").
3. **Engine check.** App runs the bundled Colibri binary with a version check. If it fails, show a clear error with a "Copy details" button. Note: Colibri's server needs a model, so the server itself starts only when the user loads a model (step 9). "Colibri starts" in the MVP means "engine found and working".
4. **Models screen.** List comes from the curated catalog + Hugging Face public API (section 5.3). Every model has a fit label. Recommended models are shown first.
5. **Model detail.** User opens a model and sees its variants (for example Q4, Q8). Each variant has its own fit label, download size, needed RAM, and estimated speed. The best fitting variant is pre-selected.
6. **Disk check.** Before download the app checks free space on the models folder. Needed space = download size + 10% safety margin. If not enough, the Download button is disabled with the reason.
7. **Download.** Resumable, chunked download managed by Rust. Shows progress, speed, time left. Pause, resume, cancel. Survives app restart.
8. **Verify and import.** Check SHA-256 against Hugging Face metadata. For GGUF, run `coli import`. Optionally run `coli tune` once (open question 6).
9. **Load.** App starts `coli serve --model <dir>` on a free local port and waits for `/v1/models` to answer. Shows "Loading model…" with progress text.
10. **Chat.** ChatGPT-like screen with streaming replies, markdown, code highlighting, stop button, tokens/sec and time-to-first-token. Chats saved locally.

### Error states the MVP must handle

| Situation | What the user sees |
|---|---|
| No internet on first open | Hardware scan still works. Models screen shows "Can't reach Hugging Face" with Retry. Already downloaded models still work. |
| Hugging Face rate limit | Show cached list with "Last updated <time>". Retry later automatically. |
| Gated model (needs login on HF) | Badge "Needs Hugging Face token". Download asks for token (section 6.2). |
| Not enough disk | Download disabled, reason shown, "Change models folder" link. |
| Colibri crashes while loading or chatting | Message "The model stopped unexpectedly", with Retry and "Copy details". App does not crash. |
| User picks a "Won't run" model anyway | Allowed only behind a warning dialog ("This will very likely fail. Download anyway?"). |

---

## 5. Hardware fit score (the new feature)

### 5.1 Hardware we detect

Detected in Rust on every launch (fast) and on demand ("Rescan" in Settings).

| Item | How (suggested crate / API) | Used for |
|---|---|---|
| CPU model, cores, threads, architecture (x86_64 / arm64) | `sysinfo` | Speed estimate, binary selection |
| CPU features (AVX2, AVX-512, NEON) | `std::arch` feature detection | Speed estimate |
| Total RAM | `sysinfo` | Fit check |
| Available RAM (right now) | `sysinfo` | Fit check, warnings |
| GPU present, name, vendor, VRAM | Vulkan device list (`ash` / `wgpu`), NVML for NVIDIA, Metal on macOS | Speed estimate, backend choice |
| Apple Silicon unified memory | macOS `sysctl` | GPU and RAM share memory, count once |
| Models folder disk: free space, total, type (NVMe / SATA SSD / HDD) | `sysinfo` disks (`DiskKind`), OS APIs | Disk check, streaming speed |
| Disk read speed (optional quick test) | Read a 512 MB temp file, measure MB/s | Streaming speed estimate |
| OS and version | `sysinfo` / `os_info` | Support checks |

Hardware profile is cached locally. Nothing is sent anywhere.

### 5.2 Inputs per model variant

| Input | Symbol | Where it comes from |
|---|---|---|
| Download size | `S` (GB) | HF file sizes |
| RAM to start | `R_min` (GB) | Colibri catalog. If missing, estimated (5.4) |
| RAM for measured speed | `R_good` (GB) | Colibri catalog. If missing, estimated (5.4) |
| Total parameters | `P_total` | HF metadata / GGUF metadata |
| Active parameters per token (MoE) | `P_active` | Catalog or GGUF metadata. Dense model: `P_active = P_total` |
| Bits per weight | `b` | Quantization (Q4 ≈ 4.5, Q8 ≈ 8.5, BF16 = 16) |
| Architecture | `arch` | GGUF `general.architecture` / catalog |

### 5.3 Model list source

1. **Curated catalog (primary).** A small JSON file shipped with the app (and refreshable from GitHub) listing models we have tested, with Colibri's `R_min`, `R_good`, sizes, active params, and Hugging Face repo id. Start from the Colibri README table.
2. **Hugging Face search (secondary, "More models" tab).** Public API without token, e.g. `GET https://huggingface.co/api/models?library=gguf&search=<q>&sort=downloads` plus model info for file sizes and GGUF architecture. Only models whose architecture Colibri supports are shown.
3. Responses are cached locally for 24 hours to avoid rate limits.

### 5.4 Estimating RAM when the catalog has no numbers

```text
bytes_per_param = b / 8
weights_GB      = P_total  * bytes_per_param
active_GB       = P_active * bytes_per_param
overhead_GB     = 1.5                         # engine, buffers, KV cache for 4k context

Dense model:   R_min  = weights_GB + overhead_GB
               R_good = R_min
MoE model:     R_min  = shared_GB + 2 * active_GB + overhead_GB
               R_good = R_min + 25% of expert_GB (hot expert cache), capped at weights_GB + overhead_GB
```

`shared_GB` is the non-expert part (attention, embeddings, router). If unknown, assume 10% of `weights_GB`. **Assumption to check:** whether dense models in Colibri must fit fully in RAM or can also stream from disk.

### 5.5 Usable memory

```text
os_reserve   = max(4 GB, 20% of total RAM)
ram_budget   = min(total_RAM - os_reserve, available_RAM + reclaimable_estimate)
gpu_budget   = VRAM - 1 GB            (0 if no supported GPU; 0 on Apple Silicon because it is already RAM)
mem_budget   = ram_budget + gpu_budget
```

`reclaimable_estimate` = 50% of RAM used by other apps' cache. Simple first version: `ram_budget = total_RAM - os_reserve`, and show a warning when available RAM right now is lower than `R_min` ("Close some apps to free memory").

### 5.6 Speed estimate (tokens per second)

Generating one token reads the active weights once. Part comes from RAM/VRAM, part from SSD when the model does not fit.

```text
active_GB      = P_active * b / 8
in_memory_frac = clamp((mem_budget - R_min) / max(R_good - R_min, 0.1), 0, 1)
                 # 1 = everything hot in memory, 0 = experts always streamed from disk
                 # dense models that fit: in_memory_frac = 1

t_mem   = active_GB * in_memory_frac       / BW_mem
t_disk  = active_GB * (1 - in_memory_frac) / BW_disk
tok_s   = efficiency / (t_mem + t_disk)
```

Default bandwidth values until we measure them:

| Hardware | `BW_mem` (GB/s) | | Disk | `BW_disk` (GB/s, random reads) |
|---|---|---|---|---|
| Laptop DDR4 dual channel | 30 | | NVMe Gen4 | 3.0 |
| Desktop DDR5 dual channel | 60 | | NVMe Gen3 | 1.5 |
| Apple M-series base / Pro / Max | 100 / 200 / 400 | | SATA SSD | 0.4 |
| NVIDIA / AMD dGPU (VRAM part) | 300+ | | HDD | 0.05 |

`efficiency` starts at 0.5. **Calibration:** after every chat, Colibri reports real tokens/sec. We store the ratio `real / estimated` per machine and use its average as `efficiency` from then on. So estimates get better on each user's machine.

**Check against Colibri:** compare our formula with the README numbers (for example Qwen3.6-35B-A3B at 6 tok/s on CPU, DeepSeek V4 Flash at 0.93 tok/s with 32 GB RAM) and tune the default table. If `coli plan` gives machine-readable output, prefer its placement over our `in_memory_frac` guess.

### 5.7 Labels (the three buckets)

Checked in this order. The first rule that matches wins.

| Label | Rule | Example reason shown |
|---|---|---|
| **Won't run** | `mem_budget < R_min` | "Needs at least 20 GB RAM. Your computer can give it 12 GB." |
| **Won't run** | Disk is HDD and model needs streaming (`in_memory_frac < 1`) | "Needs an SSD. Your models folder is on a hard disk." |
| **Won't run** | `tok_s < 0.5` | "Would be extremely slow (about 1 word every 3 seconds)." |
| **Will run slowly** | `0.5 ≤ tok_s < 5` | "Runs, but slowly: about 2 words/sec." |
| **Recommended** | `tok_s ≥ 5` | "Runs well: about 9 words/sec." |

Disk space is shown separately ("Not enough disk space: needs 25 GB, 18 GB free") because the user can fix it by freeing space or changing the folder. It does not change the label.

Speed thresholds: 5 tok/s is about reading speed. Thresholds live in one config file so we can tune them.

### 5.8 Ordering and the Recommended list

1. The top "Recommended for your computer" section shows up to 5 models labelled **Recommended**, sorted by **quality first** (bigger `P_total` is usually smarter; catalog can override with a `quality_rank`), then by speed.
2. Below that, "All models" grouped Recommended → Will run slowly → Won't run, with a filter chip for each label.
3. For each model, the pre-selected variant is the highest quality variant that is still **Recommended**, else the fastest variant that runs.
4. A small "Why?" link on every label opens the numbers (RAM needed vs yours, estimated speed, disk).

### 5.9 Acceptance tests for the fit score

- Unit tests with fixed hardware profiles (8 GB laptop, 16 GB laptop, 32 GB desktop, 64 GB + RTX 4090, Mac M3 Pro 36 GB) and the catalog give stable, expected labels.
- On at least 3 real machines, every "Recommended" model reaches ≥ 5 tok/s and every "Won't run" (RAM rule) really fails or is unusable.

---

## 6. Data: what we store and where

### 6.1 Storage map

| Data | Where | Format | Leaves the machine? |
|---|---|---|---|
| Chats and messages | App data folder (Tauri `app_data_dir`) | SQLite | **Never** |
| Hugging Face token (optional) | OS keychain: macOS Keychain, Windows Credential Manager, Linux Secret Service (`keyring` crate) | Secret | Only to huggingface.co, for downloads |
| Settings (models folder, RAM reserve, theme) | App config folder | JSON | Never |
| Hardware profile + speed calibration | App data folder | SQLite / JSON | Never |
| Model catalog cache | App cache folder | JSON | Never |
| Downloaded models | Models folder (default inside app data, user can change, e.g. an external NVMe) | GGUF / colibri containers | Never |
| Logs | App log folder, rotated, max 20 MB | Text | Only if user clicks "Copy details" and shares it |
| Anything on our server | Nothing in the MVP | — | — |

### 6.2 Hugging Face token rules

- Optional. Only asked when a gated model is downloaded, or added in Settings.
- Stored in the OS keychain, never in plain files, logs, or SQLite.
- Never shown again in full after saving (show `hf_••••last4`). User can remove it.
- Phase 2 option: "Sign in with Hugging Face" (OAuth) instead of pasting a token. Token still kept only in the keychain.

### 6.3 Chat data (local SQLite, suggested tables)

- `conversations`: id, title, model_id, created_at, updated_at
- `messages`: id, conversation_id, role (user / assistant / system), content, tokens, tok_per_s, ttft_ms, created_at
- `profile`: one row, `account_id` nullable (empty in MVP, ready for login later)

Chat export (Markdown / JSON) and "Delete all chats" in Settings.

---

## 7. Screens (MVP)

| # | Screen | Main content |
|---|---|---|
| 1 | Welcome | Logo, one line pitch, "Get started". Hardware scan runs here and shows a hardware card. |
| 2 | Models (Discover) | Search, "Recommended for your computer" row, "All models" list with fit label, size, est. speed, reason. Filter chips by label. |
| 3 | Model detail | Description, variants table with fit label per variant, disk check, Download button, "Why?" panel. |
| 4 | Downloads | Active and finished downloads, progress, speed, ETA, pause / resume / cancel. |
| 5 | My models | Installed models, size on disk, Load / Unload / Delete, "Open folder". |
| 6 | Chat | Sidebar with conversations, chat area, model selector, streaming reply, Stop, tok/s + time-to-first-token, engine status pill. |
| 7 | Settings | Models folder, RAM reserve slider, HF token, Rescan hardware, theme, export / delete chats, About (app + Colibri version). |

Engine status (Not loaded / Loading / Ready / Error) is a pill in the top bar, not a separate screen.

### 7.1 Responsive and UI rules

- Desktop window, but it can be resized small. Minimum window size 360 × 560.
- Layout breakpoints (Tailwind v4 defaults): below `md` (768 px) one column, sidebar becomes a drawer; `md` to `xl` sidebar collapsible; `xl` (1280 px) and up full sidebar + content (+ optional "Why?" side panel on Model detail).
- Use container queries (`@container`, `@md:` etc.) for cards so a model card looks right in both the grid and the side panel.
- Tailwind CSS v4: design tokens in CSS with `@theme` (colors, radius, spacing, fonts), no `tailwind.config.js`. Light and dark themes via `dark:` variant.
- Pixel perfect: build each screen from a design (Figma) with a fixed spacing scale; compare at 360, 768, 1280, and 1920 px widths before marking a screen done.
- Fit labels use colour **and** text/icon (not colour alone): green "Recommended", amber "Will run slowly", red/grey "Won't run".

---

## 8. Non-functional requirements

- **App footprint:** app idle RAM under 150 MB (Tauri webview), so RAM is left for the model.
- **Startup:** app window visible in under 2 s; hardware scan under 3 s.
- **Privacy:** no telemetry in the MVP. No network calls except Hugging Face (and the catalog refresh from GitHub).
- **Security:** Colibri server binds to `127.0.0.1` only, random free port. Token only in keychain.
- **Platforms:** Windows 10/11 x64, macOS 13+ (Apple Silicon first, Intel best effort), Ubuntu 22.04+ x64.
- **Stability:** a Colibri crash never crashes the app; downloads resume after restart.

---

## 9. Out of scope for the MVP (later phases)

| Item | Phase |
|---|---|
| Accounts / login with Google, Apple, email (Apple matters for Mac users) | Phase 2. Only profile info on our server; chats and HF token stay local. |
| Cloud sync of chats, multiple devices | Not planned (chats stay local by decision) |
| Sign in with Hugging Face (OAuth) | Phase 2 |
| Converting raw safetensors models (`coli convert`) inside the app | Later |
| Image generation (Qwen-Image), voice, file upload / RAG, tools, plugins | Later |
| Payments / subscriptions | Later |
| Auto-update of the app | Open question 7 |
| Mobile app | Not planned |
| Fine-tuning models | Not planned |

---

## 10. Open questions

1. **Login timing.** Your message says login is part of the product from the start, but the Google / Apple / email screens come later. This doc assumes: MVP ships **without** a login screen, and the local data is designed so login can be added later without migrating chats (`account_id` column). Is that right, or do you want a login screen in the very first build?
2. **Which models in the first catalog?** Colibri supports specific architectures only. Suggestion: start with tested small Qwen3 dense GGUFs (1.7B, 4B, 8B) so every machine has something Recommended, plus 5 to 8 bigger models (e.g. OLMoE, Qwen3-Coder-30B-A3B, Qwen3.6-35B-A3B, DeepSeek V4 Flash REAP, GLM-5.2), and add HF search as "More models". Need to test Qwen3 1.7B / 4B / 8B on Colibri (docs only benchmark 0.6B).
3. **Minimum supported machine.** Colibri says 8 GB RAM minimum. Do we support 8 GB machines (very few models will be Recommended) or set 16 GB as the minimum?
4. **Dense models streaming.** Does Colibri stream dense models (like Qwen3.8-27B) from disk, or must they fit in RAM? Changes the `R_min` formula.
5. **`coli plan` output.** Is it machine-readable (JSON)? If yes, we use it to confirm our labels after download.
6. **`coli tune` on first load.** It measures the fastest safe settings but takes time. Run it automatically after download, or offer it as a button?
7. **Auto updates** for the app and Colibri binary in the MVP, or manual download of new versions?
8. **Disk speed test.** OK to read a temporary 512 MB file on first launch to measure SSD speed (takes a few seconds), or only use disk type?
9. **Colibri licence and bundling.** Colibri is MIT. Confirm we can bundle its binaries per OS and which version we pin.
10. **Port and dashboard.** Colibri serve also opens a browser dashboard at its port. We should make sure it never opens a browser and uses our chosen port (need to check flags in Colibri's SETTINGS.md).

---

## 11. Suggested build order (after this doc is approved)

1. Tauri + React + TS + Tailwind v4 project skeleton, app shell with responsive layout.
2. Hardware scan in Rust + hardware card UI.
3. Model catalog + fit score module (pure function, unit tested with fixed profiles).
4. Models screen and Model detail with labels.
5. Download manager (resume, verify) + My models.
6. Colibri sidecar: import, serve, health check.
7. Chat screen with streaming + local SQLite.
8. Settings (models folder, HF token in keychain, rescan).
9. Calibration of speed estimates from real runs.
