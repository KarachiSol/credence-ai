import { useEffect, useState, type ReactNode } from "react";
import { IconFolder } from "../components/icons";
import { ensureColibri, refreshColibri, setupLabel, useColibri } from "../lib/colibri";
import { invoke, isTauri } from "../lib/platform";
import type { Settings } from "../lib/settings";

interface Props {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

const input =
  "h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm placeholder:text-zinc-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900";

function Section({ title, text, children }: { title: string; text?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-base font-semibold">{title}</h2>
      {text && <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{text}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>}
    </label>
  );
}

function Segmented<T extends string>(p: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={p.label} className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-800">
      {p.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={p.value === o.value}
          onClick={() => p.onChange(o.value)}
          className={`h-8 truncate rounded-lg px-2 text-sm font-medium ${
            p.value === o.value
              ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-100"
              : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function BuiltInEngine() {
  const setup = useColibri();
  useEffect(() => {
    void refreshColibri().catch(() => {});
  }, []);
  const busy = setupLabel(setup);
  const info = setup.info;
  const ok = info?.installed && info.python;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-3 sm:flex-row sm:items-center dark:border-zinc-800">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          <span
            className={`size-2 shrink-0 rounded-full ${busy ? "animate-pulse bg-amber-500" : ok ? "bg-emerald-500" : info ? "bg-rose-500" : "bg-zinc-400"}`}
          />
          {busy ??
            (!info
              ? "Checking the engine…"
              : !info.supported
                ? "No ready-made engine for this computer"
                : info.installed
                  ? `Colibri ${info.version ?? ""} installed`
                  : "Engine not installed yet")}
        </p>
        <p className="mt-0.5 text-xs break-words text-zinc-500 dark:text-zinc-400">
          {setup.phase === "error" && setup.error
            ? setup.error
            : info && !info.python
              ? `Colibri needs Python 3.10 or newer. ${info.pythonHint}`
              : info?.installed
                ? "Credence installed this for you. Nothing to set up."
                : "Credence downloads it by itself (one time) when you start a model."}
        </p>
      </div>
      {info && info.supported && !info.installed && !busy && (
        <button
          type="button"
          onClick={() => void ensureColibri().catch(() => {})}
          className="h-9 shrink-0 rounded-lg bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700"
        >
          {setup.phase === "error" ? "Try again" : "Install now"}
        </button>
      )}
    </div>
  );
}

export function SettingsScreen({ settings: s, update }: Props) {
  const [workspace, setWorkspace] = useState("");
  useEffect(() => {
    if (isTauri()) void invoke<string>("workspace_root", { root: s.workspaceDir || null }).then(setWorkspace).catch(() => {});
    else setWorkspace(s.workspaceDir || "Documents/Credence");
  }, [s.workspaceDir]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <Section title="Model engine" text="How Credence runs your models.">
        <Segmented
          label="Engine"
          value={s.engineMode}
          onChange={(v) => update({ engineMode: v })}
          options={[
            { value: "colibri", label: "Colibri (built in)" },
            { value: "custom", label: "Other server" },
          ]}
        />
        {s.engineMode === "colibri" ? (
          <>
            {!s.colibriDir.trim() && <BuiltInEngine />}
            <Field
              label="Graphics card (GPU)"
              hint="Auto uses your graphics card through Vulkan when it makes the model faster. Pick CPU only if a model crashes or your screen stutters. Applies the next time you start a model."
            >
              <Segmented
                label="Graphics card"
                value={s.gpu}
                onChange={(v) => update({ gpu: v })}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "off", label: "CPU only" },
                ]}
              />
            </Field>
            <details className="group" open={!!s.colibriDir.trim()}>
              <summary className="cursor-pointer text-sm font-medium text-zinc-600 select-none hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
                Advanced
              </summary>
              <div className="mt-4 flex flex-col gap-4">
                <Field
                  label="Use my own Colibri folder (optional)"
                  hint={
                    <>
                      Leave empty and Credence installs and updates the engine for you. Only fill this in if you
                      installed Colibri yourself: the release folder or your <code>colibri</code> checkout.
                    </>
                  }
                >
                  <input
                    className={input}
                    value={s.colibriDir}
                    onChange={(e) => update({ colibriDir: e.target.value })}
                    placeholder={navigator.userAgent.includes("Windows") ? "C:\\colibri" : "~/colibri"}
                    spellCheck={false}
                  />
                </Field>
                <Field label="Colibri address" hint="Default is fine unless you changed Colibri's port.">
                  <input className={input} value={s.colibriUrl} onChange={(e) => update({ colibriUrl: e.target.value })} spellCheck={false} />
                </Field>
              </div>
            </details>
          </>
        ) : (
          <>
            <Field label="Server address" hint="Any OpenAI-compatible server: Colibri started by hand, LM Studio, Ollama (http://127.0.0.1:11434/v1)…">
              <input className={input} value={s.customUrl} onChange={(e) => update({ customUrl: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="Model name" hint="Leave empty to use the first model the server lists.">
              <input className={input} value={s.customModel} onChange={(e) => update({ customModel: e.target.value })} spellCheck={false} />
            </Field>
            <Field label="API key (optional)">
              <input
                className={input}
                type="password"
                value={s.customApiKey}
                onChange={(e) => update({ customApiKey: e.target.value })}
                autoComplete="off"
              />
            </Field>
          </>
        )}
      </Section>

      <Section title="Web search" text="The agent searches the web and reads the best pages before answering.">
        <Segmented
          label="Search provider"
          value={s.searchProvider}
          onChange={(v) => update({ searchProvider: v })}
          options={[
            { value: "duckduckgo", label: "DuckDuckGo (free)" },
            { value: "brave", label: "Brave Search API" },
          ]}
        />
        {s.searchProvider === "brave" && (
          <Field label="Brave Search API key" hint="Get a free key at brave.com/search/api. Saved only on this computer.">
            <input
              className={input}
              type="password"
              value={s.braveKey}
              onChange={(e) => update({ braveKey: e.target.value })}
              autoComplete="off"
            />
          </Field>
        )}
        <Field label={`Pages to read per search: ${s.searchAutoRead}`} hint="More pages = better answers, but slower. 2 is a good balance.">
          <input
            type="range"
            min={0}
            max={3}
            step={1}
            value={s.searchAutoRead}
            onChange={(e) => update({ searchAutoRead: Number(e.target.value) })}
            className="w-full accent-brand-600"
          />
        </Field>
      </Section>

      <Section title="Files" text="The agent can only create and read files inside this folder.">
        <Field label="Workspace folder" hint="Leave empty for Documents/Credence.">
          <input
            className={input}
            value={s.workspaceDir}
            onChange={(e) => update({ workspaceDir: e.target.value })}
            placeholder={workspace}
            spellCheck={false}
          />
        </Field>
        {isTauri() && workspace && (
          <button
            type="button"
            onClick={() => void invoke("open_folder", { path: workspace })}
            className="inline-flex h-9 items-center gap-2 self-start rounded-lg border border-zinc-200 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <IconFolder width={16} height={16} />
            Open workspace folder
          </button>
        )}
      </Section>

      <Section title="Answers">
        <Field label={`Creativity: ${s.temperature.toFixed(1)}`} hint="Lower = more focused and factual. Higher = more creative.">
          <input
            type="range"
            min={0}
            max={1.2}
            step={0.1}
            value={s.temperature}
            onChange={(e) => update({ temperature: Number(e.target.value) })}
            className="w-full accent-brand-600"
          />
        </Field>
      </Section>
    </div>
  );
}
