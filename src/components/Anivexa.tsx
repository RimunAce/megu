import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { embedOptions, getEpisodes, getStreams, PROVIDERS, type Audio, type Episode, type Provider, type PlayerOption } from "../lib/anivexa";
import { openStreamUrl } from "../lib/tauri";
import InlinePlayer from "./InlinePlayer";
import { getPlayback, type PlaybackRecord } from "../lib/playback";
import { useAppStore, useAuthStore } from "../store/app";
import ResumePrompt from "./ResumePrompt";

export default function Anivexa({ mediaId, title, cover, durationMinutes }: { mediaId: number; title: string; cover?: string | null; durationMinutes?: number | null }) {
  const request = useAppStore((s) => s.playbackRequest);
  const viewer = useAuthStore((s) => s.viewer);
  const [prior] = useState(() => request?.mediaId === mediaId ? request : getPlayback(viewer?.id ?? null).find((r) => r.mediaId === mediaId));
  const [provider, setProvider] = useState<Provider>(prior?.provider ?? "anikoto");
  const [audio, setAudio] = useState<Audio>(prior?.audio ?? "sub");
  const [selected, setSelected] = useState<Episode | null>(() => request?.mediaId === mediaId ? { id: request.episodeId, number: request.episode, title: null } : null);
  const [player, setPlayer] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ option: PlayerOption; record: PlaybackRecord; resume: number } | null>(null);
  const [prompt, setPrompt] = useState<{ option: PlayerOption; record: PlaybackRecord } | null>(null);
  const episodes = useQuery({ queryKey: ["anivexaEpisodes", mediaId, provider], queryFn: ({ signal }) => getEpisodes(mediaId, provider, signal), staleTime: 5 * 60_000, retry: false });
  const streams = useQuery({ queryKey: ["anivexaStreams", mediaId, provider, audio, selected?.id], queryFn: ({ signal }) => getStreams(mediaId, provider, audio, selected!, signal), enabled: !!selected, staleTime: 0, retry: false });
  const list = episodes.data?.episodes?.[audio];
  const options = useMemo(() => embedOptions(streams.data ?? []), [streams.data]);
  const lastForEpisode = selected ? getPlayback(viewer?.id ?? null).find((r) => r.mediaId === mediaId && r.episodeId === selected.id && r.provider === provider && r.audio === audio) : undefined;
  const current = options.find((option) => option.url === player) ?? (lastForEpisode ? options.find((option) => option.label === lastForEpisode.server) : undefined) ?? options[0];
  const reset = () => { setSelected(null); setPlayer(null); setOpenError(null); };
  const start = () => {
    if (!selected || !current) return;
    const saved = getPlayback(viewer?.id ?? null).find((r) => r.mediaId === mediaId && r.episodeId === selected.id && r.provider === provider && r.audio === audio && r.server === current.label);
    const record: PlaybackRecord = { ...(saved ?? { mediaId, title, episodeId: selected.id, episode: selected.number, provider, audio, server: current.label, position: 0, duration: 0, updatedAt: Date.now() }), cover: cover ?? saved?.cover, expectedDuration: durationMinutes ? durationMinutes * 60 : saved?.expectedDuration };
    if (saved && saved.position > 0.5) setPrompt({ option: current, record });
    else setPlaying({ option: current, record, resume: 0 });
  };
  useEffect(() => {
    if (request?.mediaId === mediaId && selected && options.length) {
      useAppStore.setState({ playbackRequest: null });
      const savedPlayer = options.find((option) => option.label === request.server);
      const record = { ...request, cover: cover ?? request.cover, expectedDuration: durationMinutes ? durationMinutes * 60 : request.expectedDuration };
      if (!savedPlayer) setOpenError(`The saved player ${request.server} is no longer available. Choose another player to continue.`);
      else if (request.position > 0.5) setPrompt({ option: savedPlayer, record });
      else setPlaying({ option: savedPlayer, record, resume: 0 });
    }
  }, [request, mediaId, selected, options, cover, durationMinutes]);

  return <div className="mb-6 rounded-lg border border-zinc-700 bg-zinc-900 p-4">
    <h3 className="text-lg font-semibold">Episodes</h3>
    <p className="mt-1 text-sm text-zinc-400">Sources are supplied by Anivexa; availability and playback vary.</p>
    <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-950/50 p-3 text-xs text-zinc-300" aria-live="polite"><strong>Provider diagnostics</strong><p className="mt-1">{episodes.isLoading ? "Checking episode availability…" : episodes.error ? "Could not reach or read the episode service. Check your connection and retry; the provider may be unavailable." : !Array.isArray(list) || !list.length ? `No ${audio} episodes were returned by ${provider}. Try another provider or audio option.` : selected && streams.isFetching ? "Checking available players…" : selected && streams.error ? "The episode list loaded, but the player request failed. Retry or choose a different provider." : selected && streams.data && !current ? "The provider returned no player MEGU can use for this episode." : selected && current ? "A player is available; actual playback and progress tracking depend on the provider." : `${list.length} ${audio} episodes found. Select one to check players.`}</p><p className="mt-1 text-zinc-500">Some providers require verification or block playback and may not expose playback progress.</p></div>
    <div className="mt-4 flex flex-wrap gap-3 text-sm">
      <label className="flex items-center gap-2">Provider <select value={provider} onChange={(e) => { setProvider(e.target.value as Provider); reset(); }} className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2">{PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
      <label className="flex items-center gap-2">Audio <select value={audio} onChange={(e) => { setAudio(e.target.value as Audio); reset(); }} className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2"><option value="sub">Sub</option><option value="dub">Dub</option></select></label>
    </div>
    {episodes.isLoading && <p className="mt-4 text-sm text-zinc-400">Loading episodes…</p>}
    {episodes.error && <div className="mt-4 text-sm text-red-300"><p role="alert">{episodes.error.message}</p><button className="mt-2 underline" onClick={() => void episodes.refetch()}>Retry</button></div>}
    {!episodes.isLoading && !episodes.error && (!Array.isArray(list) || list.length === 0) && <p className="mt-4 text-sm text-zinc-400">{episodes.data?.error || `No ${audio} episodes found for this provider. Try another provider or audio option.`}</p>}
    {Array.isArray(list) && list.length > 0 && <div className="mt-4 grid max-h-80 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">{list.filter((ep) => ep && typeof ep.id === "string" && Number.isFinite(ep.number)).map((ep) => <button key={ep.id} onClick={() => { setSelected(ep); setPlayer(null); setOpenError(null); }} className={`rounded p-3 text-left text-sm ${selected?.id === ep.id ? "bg-zinc-600" : "bg-zinc-800 hover:bg-zinc-700"}`}>Episode {ep.number}{ep.title && !/^episode\s*\d+$/i.test(ep.title.trim()) ? ` · ${ep.title}` : ""}</button>)}</div>}
    {selected && <section className="mt-5" aria-label="Episode player">
      <h4 className="font-semibold">{title} · Episode {selected.number} ({audio})</h4>
      {streams.isFetching && <p className="mt-3 text-sm text-zinc-400">Finding a player…</p>}
      {streams.error && <div className="mt-3 text-sm text-red-300"><p role="alert">{streams.error.message}</p><button className="mt-2 underline" onClick={() => void streams.refetch()}>Retry</button></div>}
      {streams.data && !current && <p className="mt-3 text-sm text-zinc-400">No supported player was returned. Try another provider or audio option.</p>}
      {current && <><div className="mt-3 flex flex-wrap items-center gap-3"><label className="text-sm">Player <select value={current.url} onChange={(e) => setPlayer(e.target.value)} className="ml-2 rounded border border-zinc-700 bg-zinc-800 px-3 py-2">{options.map((o) => <option key={o.url} value={o.url}>{o.label}</option>)}</select></label><button onClick={start} className="rounded bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-zinc-200">Play in MEGU</button><button onClick={() => { setOpenError(null); void openStreamUrl(current.url).catch((e: unknown) => setOpenError(String(e))); }} className="text-sm text-zinc-300 underline">Open in browser ↗</button><button onClick={reset} className="text-sm text-zinc-300 underline">Close</button></div>
        {openError && <p role="alert" className="mt-2 text-sm text-red-300">{openError}</p>}
        {playing && <InlinePlayer option={playing.option} record={playing.record} resume={playing.resume} onClose={() => setPlaying(null)} />}
        {prompt && <ResumePrompt record={prompt.record} onYes={() => { setPlaying({ ...prompt, resume: prompt.record.position }); setPrompt(null); }} onNo={() => { setPlaying({ ...prompt, resume: 0 }); setPrompt(null); }} onCancel={() => setPrompt(null)} />}
        <p className="mt-2 text-xs text-zinc-500">Player and streams are hosted by the selected provider. If playback fails, try another provider, another audio option, or open it in your browser.</p>
      </>}
    </section>}
  </div>;
}
