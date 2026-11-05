import { invoke, isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";

export type UpdateMode = "check" | "download" | "manual";
type Phase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "error" | "unavailable";
type UpdateState = {
  mode: UpdateMode; phase: Phase; version: string; latest: string; notes: string;
  error: string; downloaded: number; total: number | null; lastChecked: number | null;
};

const modeKey = "megu.updates.mode";
const checkedKey = "megu.updates.lastChecked";
const interval = 6 * 60 * 60 * 1000;
function newerVersion(candidate: string, current: string): boolean {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
    return match ? { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split(".") } : null;
  };
  const a = parse(candidate), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
  if (!a.pre || !b.pre) return !a.pre && !!b.pre;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const left = a.pre[i], right = b.pre[i];
    if (left === undefined || right === undefined) return right === undefined && left !== undefined;
    if (left === right) continue;
    const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right);
    if (leftNumeric !== rightNumeric) return rightNumeric;
    return left > right;
  }
  return false;
}
function storedMode(): UpdateMode {
  try { const value = localStorage.getItem(modeKey); return value === "manual" || value === "download" ? value : "check"; } catch { return "check"; }
}
function storedCheck(): number | null {
  try { const value = Number(localStorage.getItem(checkedKey)); return value > 0 && value <= Date.now() ? value : null; } catch { return null; }
}
export const useUpdater = create<UpdateState>(() => ({ mode: storedMode(), phase: "idle", version: "", latest: "", notes: "", error: "", downloaded: 0, total: null, lastChecked: storedCheck() }));
let update: Update | null = null;
let pending: Promise<void> | null = null;
const set = useUpdater.setState;

export function setUpdateMode(mode: UpdateMode) {
  try { localStorage.setItem(modeKey, mode); } catch { /* Settings remain active for this session. */ }
  set({ mode });
  if (mode === "download" && useUpdater.getState().phase === "available") void downloadUpdate();
}

export async function initializeUpdater() {
  if (!isTauri()) { set({ phase: "unavailable", error: "Updates are available in the Windows desktop app." }); return; }
  try {
    const [version, configured] = await Promise.all([getVersion(), invoke<boolean>("updater_configured")]);
    set({ version });
    if (!configured) { set({ phase: "unavailable", error: "This build has no update verification key. Download a release from GitHub instead." }); return; }
    await automaticCheck(true);
  } catch (error) { set({ phase: "unavailable", error: `Updater unavailable: ${String(error)}` }); }
}

export async function automaticCheck(startup = false) {
  const state = useUpdater.getState();
  if (state.mode === "manual" || state.phase === "unavailable" || (!(startup && !update) && state.lastChecked && Date.now() - state.lastChecked < interval)) return;
  await checkForUpdates();
}

export function checkForUpdates(): Promise<void> {
  if (pending) return pending;
  if (!isTauri() || useUpdater.getState().phase === "unavailable") return Promise.resolve();
  if (useUpdater.getState().phase === "downloading" || useUpdater.getState().phase === "installing") return Promise.resolve();
  const downloaded = useUpdater.getState().phase === "ready" ? update : null;
  pending = (async () => {
    set({ phase: "checking", error: "" });
    try {
      const next = await check({ timeout: 30000 });
      if (downloaded && next && !newerVersion(next.version, downloaded.version)) {
        await next.close().catch(() => {});
        const lastChecked = Date.now();
        try { localStorage.setItem(checkedKey, String(lastChecked)); } catch { /* The downloaded update remains usable. */ }
        set({ lastChecked, phase: "ready" });
        return;
      }
      if (update) await update.close().catch(() => {});
      update = next;
      const lastChecked = Date.now();
      try { localStorage.setItem(checkedKey, String(lastChecked)); } catch { /* Checking still works without persistence. */ }
      set({ lastChecked, phase: next ? "available" : "current", latest: next?.version ?? "", notes: next?.body ?? "" });
    } catch (error) { set({ phase: downloaded ? "ready" : "error", error: `Could not check for updates: ${String(error)}` }); }
  })().finally(() => { pending = null; });
  return pending.then(async () => { if (useUpdater.getState().phase === "available" && useUpdater.getState().mode === "download") await downloadUpdate(); });
}

export async function downloadUpdate() {
  if (!update || useUpdater.getState().phase !== "available") return;
  set({ phase: "downloading", downloaded: 0, total: null, error: "" });
  let downloaded = 0;
  let lastPublished = 0;
  try {
    await update.download((event) => {
      if (event.event === "Started") set({ total: event.data.contentLength ?? null });
      if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        const now = performance.now();
        if (now - lastPublished >= 250) { lastPublished = now; set({ downloaded }); }
      }
    });
    set({ phase: "ready", downloaded });
  } catch (error) { set({ phase: "available", error: `Download failed: ${String(error)}` }); }
}

export async function installUpdate() {
  if (!update || useUpdater.getState().phase !== "ready") return;
  if (document.querySelector('[role="dialog"][aria-label="Episode player"]')) { set({ error: "Close the player before installing an update." }); return; }
  set({ phase: "installing", error: "" });
  try { await invoke("updater_install_allowed"); } catch (error) { set({ phase: "ready", error: String(error) }); return; }
  try { await update.install(); } catch (error) {
    await update.close().catch(() => {});
    update = null;
    set({ phase: "error", error: `Installation failed: ${String(error)}. Check for updates to try again.` });
  }
}
