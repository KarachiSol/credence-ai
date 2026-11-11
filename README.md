# Credence AI

Desktop app (Tauri + React + TypeScript + Tailwind CSS v4) that runs large AI models locally with the Colibri engine. It checks your hardware and labels every model **Recommended**, **Will run slowly**, or **Won't run**.

Requirements and the fit-score formula: [docs/mvp-requirements-and-hardware-model-fit.md](docs/mvp-requirements-and-hardware-model-fit.md).

## What works so far

- Hardware scan in Rust (`src-tauri/src/hardware.rs`): CPU, RAM, GPU, models drive.
- Fit score (`src/lib/fit.ts`) with unit tests (`src/lib/fit.test.ts`).
- Responsive app shell and Models screen with the Recommended list.
- Model downloads from Hugging Face (`src-tauri/src/downloads.rs`): resume after pause or restart, SHA-256 check, Downloads and My models screens. Set `HF_ENDPOINT` to use a mirror.
- Auto update (see below).
- Chat with an agent (`src/lib/agent.ts`): streaming replies, thinking, tool calls with permission, sources. Chats saved in local SQLite.
- Engine (`src-tauri/src/engine.rs`): starts `coli serve` for a downloaded model (runs `coli import` for GGUF first). Or connect to any OpenAI-compatible server (Settings → Other server).
- Tools (`src/lib/tools.ts`): web search (DuckDuckGo or Brave, reads the top pages automatically), read web page, create / read / list files in the workspace folder (Documents/Credence), remember / forget, current time.
- Memory (`src/lib/memory.ts`): learns facts and preferences from chats, puts the relevant ones in the prompt, Memory screen to view / edit / delete. Works with any model.
- Plans: [docs/agent-and-memory-roadmap.md](docs/agent-and-memory-roadmap.md).

### Trying the agent

1. Download the [Colibri release](https://github.com/JustVugg/colibri/releases) for your OS and unzip it.
2. Settings → Model engine → Colibri folder: the unzipped folder.
3. Download a model (Qwen3 8B or bigger works best as an agent), then Chat → Start.

Already run a model server (Colibri by hand, LM Studio, Ollama)? Settings → Other server, then Chat → Connect.

## Get the installers (no Rust needed)

Every push builds the app on GitHub Actions. Open the repo's **Actions** tab, pick the latest **Desktop build** run, and download:

- `credence-ai-windows`: `.exe` and `.msi`
- `credence-ai-linux`: `.deb` (Ubuntu / Debian: `sudo apt install ./Credence*.deb`), `.AppImage` (any distro: `chmod +x` then run), `.rpm` (Fedora)

On Linux, auto update works for the **AppImage**. `.deb` / `.rpm` users install new versions by hand.

## Run it on your PC

Prerequisites: [Bun](https://bun.sh) 1.2+, Rust (stable), and the [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
bun install
bun run tauri dev     # desktop app with the real hardware scan
bun run dev           # browser only: sample laptop, fake downloads, demo chat model (add ?demo-update for the update popup)
bun run test          # fit score tests (Vitest; plain `bun test` uses Bun's own runner, so use `bun run test`)
bun run typecheck
```

## Project layout

```text
src/                 React UI
  lib/fit.ts         fit score (all tunable numbers in FIT_CONFIG)
  lib/catalog.ts     curated model list
  screens/           pages
  components/        shared UI
src-tauri/           Rust backend
  src/hardware.rs    hardware scan
docs/                requirements
```

## Auto updates

The app checks for a new version when it opens (and every 6 hours). If one exists it shows a popup and an **Update available** button at the bottom of the sidebar. One click downloads, installs and restarts.

Updates come from `latest.json` attached to the latest GitHub Release of this repo. The repo must be **public** before sharing the app, otherwise installed apps cannot download updates.

### One-time setup

1. On your PC, in this project: `bunx tauri signer generate -w credence-updater.key`. Pick a password. Keep the `.key` file safe and never commit it. If it is lost, installed apps can never update again.
2. Put the printed **public** key in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
3. In this repo: Settings → Secrets and variables → Actions, add:
   - `TAURI_SIGNING_PRIVATE_KEY`: contents of `credence-updater.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password

### Publishing a version

1. Raise `version` in `package.json` (for example `0.1.0` → `0.1.1`). The app reads its version from there.
2. Merge to `main`.
3. Actions → **Release** → **Run workflow**. It builds, signs and publishes the installer plus `latest.json`.

Only apps installed from a release build with the updater can update themselves. The first version you share publicly must come from this workflow.
