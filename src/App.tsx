import { useCallback, useEffect, useState } from "react";
import { AppShell, NAV, type ScreenId } from "./components/AppShell";
import { scanHardware } from "./lib/hardware";
import type { HardwareProfile } from "./lib/types";
import { ComingSoon } from "./screens/ComingSoon";
import { ModelsScreen } from "./screens/ModelsScreen";

const SOON: Record<Exclude<ScreenId, "models">, string> = {
  "my-models": "Models you download will show up here.",
  downloads: "Download progress will show up here.",
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

  const title = NAV.find((n) => n.id === screen)?.label ?? "";

  return (
    <AppShell active={screen} onSelect={setScreen} title={title}>
      {screen === "models" ? (
        <ModelsScreen hw={hw} scanning={scanning} error={error} onRescan={rescan} />
      ) : (
        <ComingSoon title={title} text={SOON[screen]} />
      )}
    </AppShell>
  );
}
