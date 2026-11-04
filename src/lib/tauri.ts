// Typed wrappers around Tauri Rust commands + AniList list mutations.

import { invoke } from "@tauri-apps/api/core";
import type { MediaListEntry, ListStatus } from "./anilist";

// ─── Core ────────────────────────────────────────────────────────────────────

export interface DbStatus {
  ready: boolean;
  cached_media: number;
  db_path: string;
}

export const getDbStatus = () => invoke<DbStatus>("get_db_status");

export const openAnimePahe = () => invoke<void>("open_animepahe");

/** Play a provider embed in a separate window without Tauri capabilities. */
export async function openPlayerWindow(url: string) {
  if (!isTauri) { window.open(url, "_blank", "noopener,noreferrer"); return; }
  await invoke<void>("open_player_window", { url });
}

export interface PendingProgress { media_id: number; base_progress: number; base_status: ListStatus; progress: number; }
export const saveListSnapshot = (userId: number, entries: MediaListEntry[]) => invoke<void>("save_list_snapshot", { userId, entries });
export const getListSnapshot = (userId: number) => invoke<MediaListEntry[] | null>("get_list_snapshot", { userId });
export const getPendingProgress = (userId: number) => invoke<PendingProgress[]>("get_pending_progress", { userId });
export const queueProgress = (userId: number, mediaId: number, baseProgress: number, baseStatus: ListStatus, progress: number) => invoke<void>("queue_progress", { userId, mediaId, baseProgress, baseStatus, progress });
export const clearPendingProgress = (userId: number, pending: PendingProgress) => invoke<void>("clear_pending_progress", { userId, mediaId: pending.media_id, progress: pending.progress, baseProgress: pending.base_progress, baseStatus: pending.base_status });
export const completePendingProgress = (userId: number, pending: PendingProgress) => invoke<void>("complete_pending_progress", { userId, mediaId: pending.media_id, progress: pending.progress, baseProgress: pending.base_progress, baseStatus: pending.base_status });

export async function openStreamUrl(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Invalid episode link");
  if (isTauri) await invoke<void>("open_stream_url", { url: parsed.href });
  else window.open(parsed.href, "_blank", "noopener,noreferrer");
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface OAuthResult {
  access_token: string;
}

export const startOAuth = (clientId: string, clientSecret: string, attemptId: string) =>
  invoke<OAuthResult>("start_oauth", { clientId, clientSecret: clientSecret || null, attemptId });

export const cancelOAuth = (attemptId: string) => invoke<void>("cancel_oauth", { attemptId });

export const getSavedToken = () => invoke<string | null>("get_saved_token");

export const logout = () => invoke<void>("logout");

export const getClientId = () => invoke<string | null>("get_client_id");

export const setClientId = (clientId: string) =>
  invoke<void>("set_client_id", { clientId });

// ─── Local list (synced copy) ────────────────────────────────────────────────

export interface UserListEntryLocal {
  media_id: number;
  status: string;
  progress: number;
  score: number | null;
  title: string | null;
  cover: string | null;
  episodes: number | null;
  season_year: number | null;
  format: string | null;
  average_score: number | null;
  updated_at: string | null;
}

export const syncUserList = (entries: UserListEntryLocal[]) =>
  invoke<void>("sync_user_list", { entries });

export const getLocalList = () => invoke<UserListEntryLocal[]>("get_local_list");

export const updateLocalEntry = (
  mediaId: number,
  status: string,
  progress: number,
  score: number | null,
) =>
  invoke<void>("update_local_entry", { mediaId, status, progress, score });

export const deleteLocalEntry = (mediaId: number) =>
  invoke<void>("delete_local_entry", { mediaId });

/** Detect whether we're running inside the Tauri desktop app. */
export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
