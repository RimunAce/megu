import { gql, saveListEntry } from "./anilist";
import { getPendingProgress, isTauri } from "./tauri";
import { useAuthStore } from "../store/app";

export interface SyncItem { mediaId: number; episode: number; title: string }
const storageKey = (userId: number) => `megu.autoSync.pending.${userId}`;
export function pendingAutoSync(userId: number): SyncItem[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(storageKey(userId)) ?? "[]");
    return Array.isArray(data) ? data.filter((v): v is SyncItem => v && Number.isSafeInteger(v.mediaId) && v.mediaId > 0 && Number.isSafeInteger(v.episode) && v.episode > 0 && typeof v.title === "string") : [];
  } catch { return []; }
}
function writeQueue(userId: number, items: SyncItem[]) {
  localStorage.setItem(storageKey(userId), JSON.stringify(items));
}
export function queueAutoSync(userId: number, item: SyncItem) {
  const items = pendingAutoSync(userId);
  const old = items.find((v) => v.mediaId === item.mediaId);
  if (old && old.episode >= item.episode) return;
  writeQueue(userId, [...items.filter((v) => v.mediaId !== item.mediaId), item]);
  window.dispatchEvent(new Event("megu-autosync-queued"));
}

export function syncNotice(message: string, kind: "success" | "error" = "success") {
  window.dispatchEvent(new CustomEvent("megu-sync-notice", { detail: { message, kind } }));
}

let syncing = false;
/** Retry durable account-scoped updates, keeping higher or conflicting remote edits intact. */
export async function drainAutoSync(userId: number, token: string, invalidate: (mediaId: number) => void) {
  if (syncing || localStorage.getItem("megu.autoSync") === "false") return;
  syncing = true;
  try {
    for (const item of pendingAutoSync(userId)) {
      if (useAuthStore.getState().token !== token || useAuthStore.getState().viewer?.id !== userId) break;
      if (localStorage.getItem("megu.autoSync") === "false") break;
      try {
        if (isTauri && (await getPendingProgress(userId)).some((change) => change.media_id === item.mediaId)) {
          syncNotice(`${item.title}: automatic sync is waiting for your pending manual edit.`, "error");
          continue;
        }
        const result = await gql<{ Media: { mediaListEntry: { progress: number | null } | null } }>(
          `query ($mediaId: Int!) { Media(id: $mediaId, type: ANIME) { mediaListEntry { progress } } }`, { mediaId: item.mediaId }, token,
        );
        const entry = result.Media.mediaListEntry;
        if (useAuthStore.getState().token !== token || useAuthStore.getState().viewer?.id !== userId) break;
        if (isTauri && (await getPendingProgress(userId)).some((change) => change.media_id === item.mediaId)) {
          syncNotice(`${item.title}: automatic sync is waiting for your pending manual edit.`, "error");
          continue;
        }
        const changed = (entry?.progress ?? 0) < item.episode;
        if (changed) await saveListEntry(token, item.mediaId, { progress: item.episode, ...(entry ? {} : { status: "CURRENT" }) });
        const current = pendingAutoSync(userId);
        writeQueue(userId, current.filter((other) => other.mediaId !== item.mediaId || other.episode > item.episode));
        if (changed) syncNotice(`${item.title}: AniList updated to episode ${item.episode}.`);
        invalidate(item.mediaId);
      } catch (error) {
        syncNotice(`AniList sync pending: ${error instanceof Error ? error.message : String(error)}`, "error");
        break;
      }
    }
  } finally { syncing = false; }
}
