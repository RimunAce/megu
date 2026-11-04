import { gql, saveListEntry, type ListStatus } from "./anilist";
import { completePendingProgress, getListSnapshot, getPendingProgress, isTauri, saveListSnapshot } from "./tauri";
import { useAuthStore } from "../store/app";
import { syncNotice } from "./autoSync";

let syncing = false;
/** Send queued manual edits only if AniList still matches their saved base. */
export async function drainManualSync(userId: number, token: string, invalidate: (id: number) => void) {
  if (!isTauri || syncing) return;
  syncing = true;
  try {
    for (const change of await getPendingProgress(userId)) {
      if (useAuthStore.getState().token !== token || useAuthStore.getState().viewer?.id !== userId) break;
      try {
        const result = await gql<{ Media: { mediaListEntry: { status: ListStatus | null; progress: number | null } | null } }>(
          `query ($mediaId: Int!) { Media(id: $mediaId, type: ANIME) { mediaListEntry { status progress } } }`, { mediaId: change.media_id }, token,
        );
        const remote = result.Media.mediaListEntry;
        const matchesBase = remote && (remote.progress ?? 0) === change.base_progress && remote.status === change.base_status;
        const alreadySaved = remote && (remote.progress ?? 0) === change.progress && remote.status === change.base_status;
        if (!matchesBase && !alreadySaved) {
          syncNotice(`AniList changed for title ${change.media_id}; your local edit needs review.`, "error");
          continue;
        }
        if (useAuthStore.getState().token !== token || useAuthStore.getState().viewer?.id !== userId) break;
        if (!alreadySaved) await saveListEntry(token, change.media_id, { progress: change.progress });
        const snapshot = await getListSnapshot(userId);
        if (snapshot) await saveListSnapshot(userId, snapshot.map((entry) => entry.media.id === change.media_id ? { ...entry, progress: change.progress } : entry));
        await completePendingProgress(userId, change);
        syncNotice(`AniList updated: episode ${change.progress}.`);
        invalidate(change.media_id);
      } catch (error) {
        syncNotice(`Manual edit saved locally; AniList sync will retry: ${error instanceof Error ? error.message : String(error)}`, "error");
        break;
      }
    }
  } catch (error) {
    syncNotice(`Could not load pending edits: ${error instanceof Error ? error.message : String(error)}`, "error");
  } finally { syncing = false; }
}
