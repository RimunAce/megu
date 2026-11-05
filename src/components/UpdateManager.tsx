import { useEffect } from "react";
import { automaticCheck, initializeUpdater, useUpdater } from "../lib/updater";
import { useAppStore } from "../store/app";

export default function UpdateManager() {
  const phase = useUpdater((state) => state.phase);
  const latest = useUpdater((state) => state.latest);
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  useEffect(() => {
    void initializeUpdater();
    const timer = window.setInterval(() => void automaticCheck(), 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (view === "settings" || (phase !== "available" && phase !== "ready")) return null;
  return <aside className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-lg" role="status">
    <p className="font-semibold">MEGU {latest} {phase === "ready" ? "is ready to install" : "is available"}</p>
    <button type="button" onClick={() => setView("settings")} className="mt-2 min-h-11 rounded bg-zinc-700 px-4 text-sm font-medium hover:bg-zinc-600 active:bg-zinc-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">Open update settings</button>
  </aside>;
}
