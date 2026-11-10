# Credence AI

Desktop app (Tauri + React + TypeScript + Tailwind CSS v4) that runs large AI models locally with the Colibri engine. It checks your hardware and labels every model **Recommended**, **Will run slowly**, or **Won't run**.

Requirements and the fit-score formula: [docs/mvp-requirements-and-hardware-model-fit.md](docs/mvp-requirements-and-hardware-model-fit.md).

## What works so far

- Hardware scan in Rust (`src-tauri/src/hardware.rs`): CPU, RAM, GPU, models drive.
- Fit score (`src/lib/fit.ts`) with unit tests (`src/lib/fit.test.ts`).
- Responsive app shell and Models screen with the Recommended list.
- Not yet: downloads, Colibri engine, chat, settings.

## Get the Windows installer (no Rust needed)

Every push builds a Windows installer on GitHub Actions. Open the repo's **Actions** tab, pick the latest **Desktop build** run, and download the `credence-ai-windows` artifact (a zip with the `.exe` and `.msi`).

## Run it on your PC

Prerequisites: [Bun](https://bun.sh) 1.2+, Rust (stable), and the [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
bun install
bun run tauri dev     # desktop app with the real hardware scan
bun run dev           # browser only, uses a sample 16 GB laptop profile
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
