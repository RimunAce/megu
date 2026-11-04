import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { isTauri, openAnimePahe } from "../lib/tauri";

interface RecentEpisode { media_id: number; title: string; anime_session: string; episode_session: string; episode: number }

export default function RecentEpisodes({ userId }: { userId: number }) {
  const [error, setError] = useState<string | null>(null);
  const { data = [], error: loadError } = useQuery({ queryKey: ["recentEpisodes", userId], queryFn: () => invoke<RecentEpisode[]>("get_recent_episodes", { userId }), enabled: isTauri });
  if (!isTauri) return null;
  return <section className="mb-8">
    <h2 className="mb-2 text-lg font-semibold">Recently opened episodes</h2>
    <p className="mb-3 text-sm text-zinc-400">Opening an episode is not proof it was watched. Playback position is not available from the provider.</p>
    {(error || loadError) && <p role="alert" className="mb-3 text-sm text-red-400">{error ?? String(loadError)}</p>}
    {data.length === 0 ? <p className="text-sm text-zinc-500">Episodes you open in AnimePahe will appear here.</p> : <>
      <button onClick={() => { setError(null); void openAnimePahe().catch((e: unknown) => setError(String(e))); }} className="mb-3 rounded bg-zinc-800 px-3 py-2 text-sm hover:bg-zinc-700">Open / verify AnimePahe</button>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{data.map((item) => <button key={item.media_id} onClick={() => { setError(null); void invoke("animepahe_play", { anime: item.anime_session, episode: item.episode_session }).catch((e: unknown) => setError(String(e))); }} className="rounded bg-zinc-800 p-3 text-left text-sm hover:bg-zinc-700">{item.title}<span className="block text-zinc-400">Reopen episode {item.episode} ↗</span></button>)}</div>
    </>}
  </section>;
}
