import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell, NAV, type ScreenId } from "./components/AppShell";
import { UpdateDialog } from "./components/UpdateDialog";
import { isActive, useDownloads } from "./lib/downloads";
import { useEngine } from "./lib/engine";
import { scanHardware } from "./lib/hardware";
import { useSettings } from "./lib/settings";
import { useUpdater } from "./lib/updater";
import type { HardwareProfile } from "./lib/types";
import { ChatScreen } from "./screens/ChatScreen";
import { DownloadsScreen } from "./screens/DownloadsScreen";
import { MemoryScreen } from "./screens/MemoryScreen";
import { ModelsScreen } from "./screens/ModelsScreen";
import { MyModelsScreen } from "./screens/MyModelsScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

export default function App() {
  const [screen, setScreen] = useState<ScreenId>("models");
  const [hw, setHw] = useState<HardwareProfile | null>(null);
  const [scanning, setScanning] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const rescan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      setHw(await scanHardware());
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void rescan();
  }, [rescan]);

  const { state: update, install } = useUpdater();
  const [updateOpen, setUpdateOpen] = useState(false);
  const shownOnce = useRef(false);
  // Pop up once per app start when a new version is found.
  useEffect(() => {
    if (update.status === "available" && !shownOnce.current) {
      shownOnce.current = true;
      setUpdateOpen(true);
    }
  }, [update.status]);
  const hasUpdate = update.status !== "idle" && update.version;

  const { settings, update: updateSettings } = useSettings();
  const engine = useEngine(settings);
  const [memoryVersion, setMemoryVersion] = useState(0);
  const downloads = useDownloads();
  const activeDownloads = downloads.jobList.filter((j) => isActive(j.status)).length;

  const title = NAV.find((n) => n.id === screen)?.label ?? "";

  return (
    <AppShell
      active={screen}
      onSelect={setScreen}
      title={title}
      engine={{ state: engine.info.state, label: engine.info.label }}
      onEngineClick={() => setScreen("chat")}
      badges={{ downloads: activeDownloads, "my-models": downloads.installed.length }}
      update={hasUpdate ? { version: update.version!, onOpen: () => setUpdateOpen(true) } : null}
    >
      {screen === "models" && (
        <ModelsScreen
          hw={hw}
          scanning={scanning}
          error={error}
          onRescan={rescan}
          downloads={downloads}
          onShowDownloads={() => setScreen("downloads")}
          onShowInstalled={() => setScreen("my-models")}
        />
      )}
      {screen === "downloads" && <DownloadsScreen downloads={downloads} onBrowse={() => setScreen("models")} />}
      {screen === "my-models" && (
        <MyModelsScreen
          downloads={downloads}
          onBrowse={() => setScreen("models")}
          onChat={(m) => {
            setScreen("chat");
            if (settings.engineMode === "colibri") void engine.start(m);
          }}
        />
      )}
      {/* Chat stays mounted so a running reply is not lost when switching screens. */}
      <div className={screen === "chat" ? "h-full" : "hidden"}>
        <ChatScreen
          settings={settings}
          engine={engine}
          downloads={downloads}
          onOpenSettings={() => setScreen("settings")}
          onBrowseModels={() => setScreen("models")}
          onMemoryChanged={() => setMemoryVersion((v) => v + 1)}
        />
      </div>
      {screen === "memory" && (
        <MemoryScreen settings={settings} version={memoryVersion} onToggle={(memoryEnabled) => updateSettings({ memoryEnabled })} />
      )}
      {screen === "settings" && <SettingsScreen settings={settings} update={updateSettings} />}
      <UpdateDialog open={updateOpen} state={update} onInstall={install} onLater={() => setUpdateOpen(false)} />
    </AppShell>
  );
}
