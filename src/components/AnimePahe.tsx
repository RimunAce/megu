import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri, openAnimePahe } from "../lib/tauri";
import { useAuthStore } from "../store/app";
import { useQueryClient } from "@tanstack/react-query";

interface Result { session: string; title: string; year?: number; type?: string; }
interface Episode { session: string; episode: number; title?: string; }
interface Page<T> { data: T[]; current_page?: number; last_page?: number; }

export default function AnimePahe({ title, mediaId }: { title: string; mediaId: number }) {
  const viewer = useAuthStore((s) => s.viewer);
  const queryClient = useQueryClient();
  const [query, setQuery] = useState(title);
  const [results, setResults] = useState<Page<Result> | null>(null);
  const [selected, setSelected] = useState<Result | null>(null);
  const [episodes, setEpisodes] = useState<Page<Episode> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState("");

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const search = (page = 1, term = query.trim()) => run(async () => {
    const data = await invoke<Page<Result>>("animepahe_search", { query: term, page });
    setSearched(term); setResults(data); setSelected(null); setEpisodes(null);
  });
  const loadEpisodes = (anime: Result, page = 1) => run(async () => {
    const data = await invoke<Page<Episode>>("animepahe_episodes", { session: anime.session, page });
    setSelected(anime); setEpisodes(data);
  });
  const play = (episode: Episode) => run(async () => {
    if (selected) {
      await invoke("animepahe_play", { anime: selected.session, episode: episode.session });
      if (viewer && Number.isFinite(episode.episode)) {
        await invoke("record_recent_episode", { userId: viewer.id, mediaId, title, animeSession: selected.session, episodeSession: episode.session, episode: episode.episode });
        await queryClient.invalidateQueries({ queryKey: ["recentEpisodes", viewer.id] });
      }
    }
  });

  return <div className="mb-6 rounded-lg border border-zinc-700 bg-zinc-900 p-4">
    <h3 className="font-semibold">AnimePahe</h3>
    <p className="mt-1 text-sm text-zinc-400">Open the provider window and complete any verification yourself. Once verified, it hides in the background; search here and choose the matching title. Episodes open in that window.</p>
    <button disabled={!isTauri || busy} onClick={() => void run(openAnimePahe)} className="mt-3 rounded-md bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-zinc-200 disabled:opacity-40">{isTauri ? "Open / verify AnimePahe" : "Desktop app required"}</button>
    {isTauri && <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (query.trim()) void search(); }}>
      <input aria-label="Search AnimePahe" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={200} className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm" />
      <button disabled={busy || !query.trim()} className="rounded bg-zinc-700 px-4 text-sm disabled:opacity-40">{busy ? "Loading…" : "Search"}</button>
    </form>}
    {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
    {results && !selected && <div className="mt-4 space-y-2">
      <p className="text-sm text-zinc-400">Select the correct title; matches are not automatic.</p>
      {results.data.length === 0 && <p className="text-sm text-zinc-400">No titles found. Try another name.</p>}
      {results.data.filter((r) => r.session && r.title).map((r) => <button key={r.session} disabled={busy} onClick={() => void loadEpisodes(r)} className="block w-full rounded bg-zinc-800 p-3 text-left text-sm hover:bg-zinc-700 disabled:opacity-40">{r.title} <span className="text-zinc-400">{[r.type, r.year].filter(Boolean).join(" · ")}</span></button>)}
      <Pager page={results} busy={busy} onPage={(p) => void search(p, searched)} />
    </div>}
    {selected && episodes && <div className="mt-4 space-y-2">
      <button disabled={busy} onClick={() => { setSelected(null); setEpisodes(null); }} className="text-sm text-zinc-300 underline">← Search results</button>
      <p className="font-medium">{selected.title}</p>
      {episodes.data.length === 0 && <p className="text-sm text-zinc-400">No episodes found on this page.</p>}
      <div className="grid gap-2 sm:grid-cols-2">{episodes.data.filter((ep) => ep.session).map((ep) => <button key={ep.session} disabled={busy} onClick={() => void play(ep)} className="rounded bg-zinc-800 p-3 text-left text-sm hover:bg-zinc-700 disabled:opacity-40">Episode {ep.episode}{ep.title ? ` · ${ep.title}` : ""} ↗</button>)}</div>
      <Pager page={episodes} busy={busy} onPage={(p) => void loadEpisodes(selected, p)} />
    </div>}
  </div>;
}

function Pager({ page, busy, onPage }: { page: Page<unknown>; busy: boolean; onPage: (page: number) => void }) {
  const current = page.current_page ?? 1;
  const last = page.last_page ?? 1;
  if (last <= 1) return null;
  return <div className="flex items-center gap-3 pt-2 text-sm"><button disabled={busy || current <= 1} onClick={() => onPage(current - 1)} className="disabled:opacity-40">Previous</button><span className="text-zinc-400">{current} / {last}</span><button disabled={busy || current >= last} onClick={() => onPage(current + 1)} className="disabled:opacity-40">Next</button></div>;
}
