import { useEffect, useState } from "react";
import { formatTime, getPlayback, type PlaybackRecord } from "../lib/playback";
import { useAppStore, useAuthStore } from "../store/app";

export default function ContinuePlayback() {
  const userId = useAuthStore((s) => s.viewer?.id ?? null);
  const resumeDetail = useAppStore((s) => s.resumeDetail);
  const [items, setItems] = useState<PlaybackRecord[]>(() => getPlayback(userId));
  useEffect(() => {
    const update = () => setItems(getPlayback(userId));
    update();
    window.addEventListener("megu-playback-changed", update);
    return () => window.removeEventListener("megu-playback-changed", update);
  }, [userId]);
  const latest = items.filter((item, index) => items.findIndex((other) => other.mediaId === item.mediaId) === index);
  return <section className="mb-8">
    <h2 className="mb-2 text-lg font-semibold">Continue watching</h2>
    <p className="mb-4 text-sm text-zinc-400">Resume an episode on the same provider and player.</p>
    {latest.length === 0 ? <p className="text-sm text-zinc-500">Episodes you watch in MEGU will appear here.</p> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{latest.map((item) => <button key={item.mediaId} onClick={() => resumeDetail(item)} className="flex min-w-0 items-center gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-left transition hover:border-red-500 hover:bg-zinc-800">{item.cover && <img src={item.cover} alt="" loading="lazy" className="h-20 w-14 shrink-0 rounded-lg bg-zinc-800 object-cover" />}<span className="min-w-0 flex-1"><span className="block truncate font-semibold">{item.title}</span><span className="mt-1 block text-sm text-zinc-400">Episode {item.episode} · {formatTime(item.position)} / {formatTime(item.duration)}</span><span className="mt-1 block truncate text-xs text-zinc-500">{item.provider} · {item.audio.toUpperCase()} · {item.server}</span><span className="mt-3 block h-1 overflow-hidden rounded-full bg-zinc-700"><span className="block h-full bg-red-500" style={{ width: `${Math.min(100, 100 * item.position / item.duration)}%` }} /></span></span></button>)}</div>}
  </section>;
}
