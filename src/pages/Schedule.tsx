import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { displayTitle, getAiringSchedule } from "../lib/anilist";
import { useAppStore } from "../store/app";

function startOfWeek(date: Date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return d;
}

export default function SchedulePage() {
  const [week, setWeek] = useState(() => startOfWeek(new Date()));
  const [day, setDay] = useState(() => (new Date().getDay() + 6) % 7);
  const openDetail = useAppStore((s) => s.openDetail);
  const end = new Date(week); end.setDate(end.getDate() + 7);
  const { data = [], isLoading, error } = useQuery({ queryKey: ["schedule", week.getTime()], queryFn: () => getAiringSchedule(Math.floor(week.getTime() / 1000), Math.floor(end.getTime() / 1000)), staleTime: 15 * 60_000 });
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(week); d.setDate(d.getDate() + i); return d; });
  const selected = days[day];
  const next = new Date(selected); next.setDate(next.getDate() + 1);
  const episodes = data.filter((e) => e.airingAt * 1000 >= selected.getTime() && e.airingAt * 1000 < next.getTime());
  const move = (offset: number) => setWeek((old) => { const d = new Date(old); d.setDate(d.getDate() + offset * 7); return d; });
  return <main className="mx-auto max-w-[1400px] px-4 pb-16 pt-24 sm:px-8">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-3xl font-bold">Airing schedule</h1><p className="mt-2 text-sm text-zinc-400">AniList broadcast times in your local time zone. Airing does not guarantee streaming availability.</p></div><div className="flex items-center gap-3"><button aria-label="Previous week" onClick={() => move(-1)} className="rounded-lg bg-zinc-800 px-4 py-2">‹</button><span className="text-sm">{week.toLocaleDateString(undefined, { month: "short", day: "numeric" })} to {new Date(end.getTime() - 1).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span><button aria-label="Next week" onClick={() => move(1)} className="rounded-lg bg-zinc-800 px-4 py-2">›</button></div></div>
    <div className="mt-8 flex gap-2 overflow-x-auto">{days.map((d, i) => <button key={d.toISOString()} onClick={() => setDay(i)} aria-pressed={i === day} className={`min-w-24 rounded-xl px-4 py-3 text-left ${i === day ? "bg-red-600 text-white" : "bg-zinc-900 text-zinc-300"}`}><span className="block font-semibold">{d.toLocaleDateString(undefined, { weekday: "short" })}</span><span className="text-xs">{d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></button>)}</div>
    {isLoading ? <p className="mt-8 text-zinc-400">Loading schedule…</p> : error ? <p role="alert" className="mt-8 text-red-300">{error.message}</p> : episodes.length === 0 ? <p className="mt-8 text-zinc-400">No broadcasts found for this day.</p> : <div className="mt-8 grid gap-3 md:grid-cols-2">{episodes.map((e) => <button key={e.id} onClick={() => openDetail(e.media!.id)} className="flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-left hover:border-zinc-600">{e.media?.coverImage?.large && <img className="h-20 w-14 rounded object-cover" src={e.media.coverImage.large} alt="" />}<span className="min-w-0"><span className="block truncate font-semibold">{displayTitle(e.media!.title)}</span><span className="mt-1 block text-sm text-zinc-400">Episode {e.episode} · {new Date(e.airingAt * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span></span></button>)}</div>}
  </main>;
}
