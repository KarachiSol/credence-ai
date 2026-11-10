# Credence AI

Desktop app (Tauri + React + TypeScript + Tailwind CSS v4) that runs large AI models locally with the Colibri engine. It checks your hardware and labels every model **Recommended**, **Will run slowly**, or **Won't run**.

Requirements and the fit-score formula: [docs/mvp-requirements-and-hardware-model-fit.md](docs/mvp-requirements-and-hardware-model-fit.md).

## What works so far

- Hardware scan in Rust (`src-tauri/src/hardware.rs`): CPU, RAM, GPU, models drive.
- Fit score (`src/lib/fit.ts`) with unit tests (`src/lib/fit.test.ts`).
- Responsive app shell and Models screen with the Recommended list.
- Not yet: downloads, Colibri engine, chat, settings.

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
