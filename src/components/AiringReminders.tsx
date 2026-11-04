import { useEffect } from "react";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { displayTitle, getUserList, type MediaListEntry } from "../lib/anilist";
import { isTauri } from "../lib/tauri";
import { useAuthStore } from "../store/app";

/** Reminders run while MEGU is open; stored episode keys prevent repeat toasts. */
export default function AiringReminders() {
  const token = useAuthStore((s) => s.token);
  const userId = useAuthStore((s) => s.viewer?.id);
  useEffect(() => {
    if (!isTauri || !token || !userId) return;
    let stopped = false;
    let entries: MediaListEntry[] = [];
    let fetching = false;
    const enabled = () => localStorage.getItem("megu.airingNotifications") === "true";
    const refresh = async () => {
      if (!enabled() || fetching) return;
      fetching = true;
      try {
        const result = await getUserList(token);
        if (!stopped) {
          // Keep a just-aired episode until it can be delivered, even if AniList
          // has already advanced nextAiringEpisode to the following week.
          const now = Date.now();
          for (const old of entries) {
            const next = old.media.nextAiringEpisode;
            const current = result.find((e) => e.media.id === old.media.id);
            if (next && current && next.airingAt * 1000 <= now && now - next.airingAt * 1000 < 15 * 60_000 && current.media.nextAiringEpisode?.airingAt !== next.airingAt) {
              await check();
              break;
            }
          }
          entries = result;
        }
      } catch { /* Retry on next refresh. */ }
      finally { fetching = false; }
    };
    const check = async () => {
      if (!enabled() || !(await isPermissionGranted().catch(() => false)) || stopped) return;
      const now = Date.now();
      const storageKey = `megu.airingNotified.${userId}`;
      let seen: Record<string, number> = {};
      try { seen = JSON.parse(localStorage.getItem(storageKey) ?? "{}"); } catch { /* Ignore corrupt reminder history. */ }
      if (!seen || typeof seen !== "object" || Array.isArray(seen)) seen = {};
      for (const entry of entries) {
        if (entry.status !== "CURRENT" && entry.status !== "PLANNING" && entry.status !== "REPEATING") continue;
        const airing = entry.media.nextAiringEpisode;
        if (!airing) continue;
        const when = airing.airingAt * 1000;
        const key = `${entry.media.id}:${airing.episode}:${airing.airingAt}`;
        if (when <= now && now - when < 15 * 60_000 && !seen[key] && !stopped) {
          sendNotification({ title: `${displayTitle(entry.media.title)} · Episode ${airing.episode}`, body: "Airing now. Streaming availability is not guaranteed." });
          seen[key] = now;
        }
      }
      const recent = Object.fromEntries(Object.entries(seen).filter(([, time]) => typeof time === "number" && now - time < 30 * 86400_000));
      try { localStorage.setItem(storageKey, JSON.stringify(recent)); } catch { /* Notifications may repeat if storage is unavailable. */ }
    };
    const refreshAndCheck = () => void check().then(refresh).then(check);
    const onSettings = () => refreshAndCheck();
    refreshAndCheck();
    const refreshTimer = window.setInterval(refreshAndCheck, 15 * 60_000);
    const checkTimer = window.setInterval(() => void check(), 30_000);
    window.addEventListener("megu-reminders-changed", onSettings);
    return () => { stopped = true; clearInterval(refreshTimer); clearInterval(checkTimer); window.removeEventListener("megu-reminders-changed", onSettings); };
  }, [token, userId]);
  return null;
}
