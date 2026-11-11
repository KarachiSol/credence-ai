import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell, NAV, type ScreenId } from "./components/AppShell";
import { UpdateDialog } from "./components/UpdateDialog";
import { isActive, useDownloads } from "./lib/downloads";
import { scanHardware } from "./lib/hardware";
import { useUpdater } from "./lib/updater";
import type { HardwareProfile } from "./lib/types";
import { ComingSoon } from "./screens/ComingSoon";
import { DownloadsScreen } from "./screens/DownloadsScreen";
import { ModelsScreen } from "./screens/ModelsScreen";
import { MyModelsScreen } from "./screens/MyModelsScreen";

const SOON: Record<"chat" | "settings", string> = {
  chat: "Chat with your downloaded models, fully offline.",
  settings: "Models folder, memory reserve and your Hugging Face token.",
};

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

  const downloads = useDownloads();
  const activeDownloads = downloads.jobList.filter((j) => isActive(j.status)).length;

  const title = NAV.find((n) => n.id === screen)?.label ?? "";

  return (
    <AppShell
      active={screen}
      onSelect={setScreen}
      title={title}
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
      {screen === "my-models" && <MyModelsScreen downloads={downloads} onBrowse={() => setScreen("models")} />}
      {(screen === "chat" || screen === "settings") && <ComingSoon title={title} text={SOON[screen]} />}
      <UpdateDialog open={updateOpen} state={update} onInstall={install} onLater={() => setUpdateOpen(false)} />
    </AppShell>
  );
}
