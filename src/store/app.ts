import { create } from "zustand";
import { isTauri } from "../lib/tauri";
import type { Viewer } from "../lib/anilist";
import type { PlaybackRecord } from "../lib/playback";

export type View = "home" | "search" | "detail" | "mylist" | "continue" | "schedule" | "settings";

interface AuthState {
  token: string | null;
  viewer: Viewer | null;
  ready: boolean; // true once we've checked for a saved token
  setSession: (token: string, viewer: Viewer) => void;
  clearSession: () => void;
  setReady: () => void;
}

async function tokenFingerprint(token: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  viewer: null,
  ready: false,
  setSession: (token, viewer) => { set({ token, viewer, ready: true }); void tokenFingerprint(token).then((fingerprint) => { if (get().token === token) localStorage.setItem("megu.viewer", JSON.stringify({ viewer, fingerprint })); }).catch(() => {}); },
  clearSession: () => { try { localStorage.removeItem("megu.viewer"); } catch { /* storage may be unavailable */ } set({ token: null, viewer: null, ready: true }); },
  setReady: () => set({ ready: true }),
}));

interface AppState {
  view: View;
  detailId: number | null;
  playbackRequest: PlaybackRecord | null;
  query: string;
  loginOpen: boolean;
  setLoginOpen: (open: boolean) => void;
  setView: (v: View) => void;
  openDetail: (id: number) => void;
  resumeDetail: (record: PlaybackRecord) => void;
  closeDetail: () => void;
  setQuery: (q: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: "home",
  detailId: null,
  playbackRequest: null,
  query: "",
  loginOpen: false,
  setLoginOpen: (open) => set({ loginOpen: open }),
  setView: (v) => set({ view: v, detailId: null, playbackRequest: null }),
  openDetail: (id) => set({ view: "detail", detailId: id, playbackRequest: null }),
  resumeDetail: (record) => set({ view: "detail", detailId: record.mediaId, playbackRequest: record }),
  closeDetail: () => set({ view: "home", detailId: null }),
  setQuery: (q) => set({ query: q }),
}));

/** Check the OS credential store for a saved token on startup. */
export async function restoreSession() {
  const { setSession, setReady } = useAuthStore.getState();
  try {
    if (isTauri) {
      const { getSavedToken } = await import("../lib/tauri");
      const token = await getSavedToken();
      if (token) {
        const { getViewer } = await import("../lib/anilist");
        let viewer: Viewer;
        try { viewer = await getViewer(token); }
        catch (error) {
          if (error instanceof Error && /\((401|403)\)/.test(error.message)) throw error;
          const saved = localStorage.getItem("megu.viewer");
          if (!saved) throw error;
          const cached = JSON.parse(saved) as { viewer: Viewer; fingerprint: string };
          if (cached.fingerprint !== await tokenFingerprint(token)) throw error;
          const candidate = cached.viewer;
          if (!Number.isSafeInteger(candidate.id) || typeof candidate.name !== "string") throw error;
          viewer = candidate;
        }
        setSession(token, viewer);
        return;
      }
    }
  } catch {
    // Token invalid or expired; fall through to the logged-out state.
  }
  setReady();
}
