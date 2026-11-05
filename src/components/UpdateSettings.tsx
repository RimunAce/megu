import { useState } from "react";
import { checkForUpdates, downloadUpdate, installUpdate, setUpdateMode, useUpdater, type UpdateMode } from "../lib/updater";
import { openStreamUrl } from "../lib/tauri";

const button = "min-h-11 rounded bg-zinc-700 px-4 py-2 text-sm font-semibold hover:bg-zinc-600 active:bg-zinc-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-50";
const labels = {
  idle: "Updates have not been checked yet.", checking: "Checking for updates…", current: "MEGU is up to date.",
  available: "An update is available.", downloading: "Downloading update…", ready: "Update downloaded and ready to install.",
  installing: "Starting the installer…", error: "Update check failed.", unavailable: "Automatic updates are unavailable.",
};

export default function UpdateSettings() {
  const state = useUpdater();
  const [linkError, setLinkError] = useState("");
  const busy = ["checking", "downloading", "installing"].includes(state.phase);
  const progress = state.total && state.total > 0 ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : null;
  return <section aria-labelledby="updates-heading" className="mt-8 rounded-xl border border-zinc-700 bg-zinc-900 p-4 sm:p-5">
    <h2 id="updates-heading" className="text-lg font-semibold">Updates</h2>
    <p className="mt-1 text-sm text-zinc-300">Keep MEGU up to date without interrupting playback.</p>
    <p className="mt-4 text-sm text-zinc-300">Installed version: {state.version || "Unavailable"}{state.lastChecked && <> · Last checked: {new Date(state.lastChecked).toLocaleString()}</>}</p>
    <label htmlFor="update-mode" className="mt-4 block text-sm font-semibold">Update behavior</label>
    <select id="update-mode" value={state.mode} onChange={(event) => setUpdateMode(event.target.value as UpdateMode)} className="mt-2 min-h-11 w-full max-w-lg rounded border border-zinc-500 bg-zinc-800 px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
      <option value="check">Check automatically, ask to download</option>
      <option value="download">Download automatically, ask to install</option>
      <option value="manual">Check manually</option>
    </select>
    <p className="mt-2 text-sm text-zinc-300">Installing always requires your approval and closes MEGU. Downloaded updates must be downloaded again if MEGU closes before installation.</p>
    <p className="mt-2 text-sm text-zinc-300">The in-app installer is intended for NSIS installations. If you installed MEGU using MSI, use the releases page to update manually.</p>
    <div className="mt-4" role="status" aria-live="polite"><p className="font-medium">{labels[state.phase]} {state.latest && ["available", "downloading", "ready", "installing"].includes(state.phase) && `Version ${state.latest}`}</p>
      {state.phase === "downloading" && <p className="mt-1 text-sm text-zinc-300">{progress === null ? `${(state.downloaded / 1048576).toFixed(1)} MB downloaded` : `${progress}% downloaded`}</p>}
    </div>
    {state.notes && <details className="mt-3 text-sm"><summary className="cursor-pointer font-medium">Release notes</summary><p className="mt-2 whitespace-pre-wrap break-words text-zinc-300">{state.notes}</p></details>}
    {(state.error || linkError) && <p role="alert" className="mt-3 break-words text-sm text-red-300">{state.error || linkError}</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" className={button} disabled={busy || state.phase === "unavailable" || state.phase === "ready"} onClick={() => void checkForUpdates()}>Check for updates</button>
      {state.phase === "available" && <button type="button" className={button} onClick={() => void downloadUpdate()}>Download update</button>}
      {state.phase === "ready" && <button type="button" className={button} onClick={() => void installUpdate()}>Install and restart</button>}
      <button type="button" className={button} onClick={() => { setLinkError(""); void openStreamUrl("https://github.com/RimunAce/megu/releases/latest").catch((error: unknown) => setLinkError(`Could not open releases: ${String(error)}`)); }}>Open releases</button>
    </div>
  </section>;
}
