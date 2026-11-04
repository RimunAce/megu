import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { displayTitle, getRecentlyAired, type AiredEpisode } from "../lib/anilist";
import { isTauri } from "../lib/tauri";
import { useAppStore } from "../store/app";

interface SavedFeed { items: AiredEpisode[]; savedAt: number }
interface Feed extends SavedFeed { cached: boolean }

async function loadFeed(): Promise<Feed> {
  try {
    const result: SavedFeed = { items: await getRecentlyAired(), savedAt: Date.now() };
    if (isTauri) await invoke("save_airing_feed", { feed: result }).catch(() => {});
    return { ...result, cached: false };
  } catch (error) {
    if (isTauri) {
      const saved = await invoke<SavedFeed | null>("get_airing_feed").catch(() => null);
      if (saved && Array.isArray(saved.items) && typeof saved.savedAt === "number") return { ...saved, cached: true };
    }
    throw error;
  }
}

export default function RecentReleases() {
  const openDetail = useAppStore((s) => s.openDetail);
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["recentlyAired"], queryFn: loadFeed, staleTime: 10 * 60 * 1000, retry: 1,
  });
  return <section className="mx-auto mb-10 w-full max-w-[1600px] px-4 sm:px-8">
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <h2 className="text-lg font-bold sm:text-xl">Recently aired episodes</h2>
      <span className="text-xs text-zinc-500">AniList broadcast schedule · streaming availability may differ</span>
      <button onClick={() => void refetch()} disabled={isFetching} className="ml-auto rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-40">{isFetching ? "Refreshing…" : "Refresh"}</button>
    </div>
    {data?.cached && <p className="mb-3 text-sm text-amber-300">Showing cached schedule from {new Date(data.savedAt).toLocaleString()}; AniList is currently unavailable.</p>}
    {error && !data && <p role="alert" className="text-sm text-red-400">Could not load the airing schedule. {error instanceof Error ? error.message : String(error)}</p>}
    {isLoading && <p className="text-sm text-zinc-400">Loading recent airings…</p>}
    {data && data.items.length === 0 && <p className="text-sm text-zinc-400">No recent airings were returned by AniList.</p>}
    {data && <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
      {data.items.filter((item) => item.media).map((item) => {
        const media = item.media!;
        const cover = media.coverImage?.large || media.coverImage?.extraLarge;
        return <button key={item.id} onClick={() => openDetail(media.id)} className="flex overflow-hidden rounded-lg bg-zinc-900 text-left hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-white">
          <div className="w-20 shrink-0 bg-zinc-800">{cover && <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover" />}</div>
          <div className="min-w-0 p-3"><p className="line-clamp-2 text-sm font-medium">{displayTitle(media.title)}</p><p className="mt-1 text-xs text-zinc-300">Episode {item.episode}</p><p className="mt-1 text-xs text-zinc-500">{new Date(item.airingAt * 1000).toLocaleString()}</p></div>
        </button>;
      })}
    </div>}
  </section>;
}
