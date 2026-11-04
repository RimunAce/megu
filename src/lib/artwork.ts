import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauri";

export const cacheArtwork = (url: string) => isTauri ? invoke<void>("cache_artwork", { url }) : Promise.resolve();
export const getCachedArtwork = (url: string) => isTauri ? invoke<string | null>("get_cached_artwork", { url }) : Promise.resolve(null);

/** Download in a small worker pool; only AniList's CDN is accepted by the backend. */
export async function cacheListArtwork(urls: (string | null | undefined)[]) {
  if (!isTauri) return;
  const queue = [...new Set(urls.filter((v): v is string => !!v))].slice(0, 300);
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) { const url = queue.shift(); if (url) await cacheArtwork(url).catch(() => {}); }
  }));
}
