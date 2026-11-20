import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { embedOptions, getEpisodes, getStreams, PROVIDERS, type Audio, type Episode, type Provider, type PlayerOption } from "../lib/anivexa";
import { openStreamUrl } from "../lib/tauri";
import InlinePlayer from "./InlinePlayer";
import { getPlayback, type PlaybackRecord } from "../lib/playback";
import { useAppStore, useAuthStore } from "../store/app";
import ResumePrompt from "./ResumePrompt";
import { getProviderHealth, rankPlayerOptions, rankProviders, type ProviderHealthEntry } from "../lib/providerHealth";
import { findAvailableProviderForEpisodes, findFallbackProviderSources } from "../lib/sourceResolver";

interface PlayingState {
  option: PlayerOption;
  options: PlayerOption[];
  record: PlaybackRecord;
  resume: number;
}

export default function Anivexa({ mediaId, title, cover, durationMinutes }: { mediaId: number; title: string; cover?: string | null; durationMinutes?: number | null }) {
  const queryClient = useQueryClient();
  const request = useAppStore((s) => s.playbackRequest);
  const viewer = useAuthStore((s) => s.viewer);
  const [prior] = useState(() => request?.mediaId === mediaId ? request : getPlayback(viewer?.id ?? null).find((r) => r.mediaId === mediaId));
  const [health, setHealth] = useState<ProviderHealthEntry[]>([]);
  const [healthLoaded, setHealthLoaded] = useState(false);
  const [provider, setProvider] = useState<Provider>(prior?.provider ?? "anikoto");
  const [userPickedProvider, setUserPickedProvider] = useState(!!prior?.provider);
  const [audio, setAudio] = useState<Audio>(prior?.audio ?? "sub");
  const [selected, setSelected] = useState<Episode | null>(() => request?.mediaId === mediaId ? { id: request.episodeId, number: request.episode, title: null } : null);
  const [player, setPlayer] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<PlayingState | null>(null);
  const [prompt, setPrompt] = useState<{ option: PlayerOption; options: PlayerOption[]; record: PlaybackRecord } | null>(null);
  const [autoFallbackNotice, setAutoFallbackNotice] = useState<string | null>(null);
  const [switchingSource, setSwitchingSource] = useState(false);
  const [failoverMessage, setFailoverMessage] = useState<string | null>(null);
  const triedUrls = useRef<Set<string>>(new Set());
  const triedProviders = useRef<Set<Provider>>(new Set());
  const autoProbedEpisodesFor = useRef<string | null>(null);
  const failoverAbort = useRef<AbortController | null>(null);
  const selectionRef = useRef({ mediaId, provider, audio, episodeNumber: selected?.number ?? null });
  selectionRef.current = { mediaId, provider, audio, episodeNumber: selected?.number ?? null };

  const refreshHealth = useCallback(async () => {
    const rows = await getProviderHealth();
    setHealth(rows);
    return rows;
  }, []);

  useEffect(() => {
    let active = true;
    void getProviderHealth().then((rows) => {
      if (!active) return;
      setHealth(rows);
      setHealthLoaded(true);
      if (!prior?.provider && rows.length > 0) {
        const best = rankProviders(PROVIDERS, rows)[0];
        if (best && !userPickedProvider) setProvider(best);
      }
    });
    return () => { active = false; };
  }, [prior?.provider, userPickedProvider]);

  const rankedProviders = useMemo(() => rankProviders(PROVIDERS, health, prior?.provider ?? null), [health, prior?.provider]);

  const episodes = useQuery({ queryKey: ["anivexaEpisodes", mediaId, provider], queryFn: ({ signal }) => getEpisodes(mediaId, provider, signal), staleTime: 5 * 60_000, retry: false });
  const streams = useQuery({ queryKey: ["anivexaStreams", mediaId, provider, audio, selected?.id], queryFn: ({ signal }) => getStreams(mediaId, provider, audio, selected!, signal), enabled: !!selected, staleTime: 0, retry: false });
  const list = episodes.data?.episodes?.[audio];
  const options = useMemo(() => rankPlayerOptions(provider, embedOptions(streams.data ?? []), health), [provider, streams.data, health]);
  const autoProbedStreamsFor = useRef<Set<string>>(new Set());

  // If a selected episode has no usable players (or streams request errored)
  // on the current provider, automatically probe another provider for that episode.
  useEffect(() => {
    if (!selected || streams.isFetching || playing) return;
    const noPlayers = !streams.error && Array.isArray(streams.data) && options.length === 0;
    if (!streams.error && !noPlayers) return;
    const key = `${mediaId}:${provider}:${audio}:${selected.number}`;
    if (autoProbedStreamsFor.current.has(key)) return;
    const controller = new AbortController();
    void findFallbackProviderSources({
      mediaId,
      episodeNumber: selected.number,
      audio,
      excludeProviders: [provider],
      health,
      signal: controller.signal,
    }).then((fallback) => {
      if (controller.signal.aborted) return;
      autoProbedStreamsFor.current.add(key);
      const active = selectionRef.current;
      if (active.mediaId !== mediaId || active.provider !== provider || active.audio !== audio || active.episodeNumber !== selected.number) return;
      if (!fallback) return;
      setAutoFallbackNotice(`No usable player on ${provider} for Episode ${selected.number}; switched to ${fallback.provider}.`);
      setProvider(fallback.provider);
      setSelected(fallback.episode);
      setPlayer(fallback.options[0]?.url ?? null);
    });
    return;
  }, [selected, streams.isFetching, streams.error, streams.data, options.length, playing, mediaId, provider, audio, health]);

  // If the initially selected provider has no episodes or errored (and the user
  // didn't explicitly pick it), automatically probe healthy fallback providers.
  useEffect(() => {
    if (!healthLoaded || userPickedProvider || episodes.isLoading) return;
    const empty = !episodes.error && (!Array.isArray(list) || list.length === 0);
    if (!episodes.error && !empty) return;
    const probeKey = `${mediaId}:${audio}:${provider}`;
    if (autoProbedEpisodesFor.current === probeKey) return;
    autoProbedEpisodesFor.current = probeKey;
    const controller = new AbortController();
    void findAvailableProviderForEpisodes({
      mediaId,
      audio,
      excludeProviders: [provider],
      health,
      signal: controller.signal,
    }).then((found) => {
      if (!found || controller.signal.aborted) return;
      queryClient.setQueryData(["anivexaEpisodes", mediaId, found.provider], (previous: { episodes?: Partial<Record<Audio, Episode[]>> } | undefined) => ({
        ...previous,
        episodes: { ...previous?.episodes, [audio]: found.episodes },
      }));
      setAutoFallbackNotice(`Switched automatically from ${provider} to ${found.provider} (${found.episodes.length} ${audio} episodes available).`);
      setProvider(found.provider);
    });
    return () => controller.abort();
  }, [healthLoaded, userPickedProvider, episodes.isLoading, episodes.error, list, mediaId, audio, provider, health, queryClient]);

  const lastForEpisode = selected ? getPlayback(viewer?.id ?? null).find((r) => r.mediaId === mediaId && r.episodeId === selected.id && r.provider === provider && r.audio === audio) : undefined;
  const current = options.find((option) => option.url === player) ?? (lastForEpisode ? options.find((option) => option.label === lastForEpisode.server) : undefined) ?? options[0];

  const reset = () => {
    setSelected(null);
    setPlayer(null);
    setOpenError(null);
    setFailoverMessage(null);
  };

  const beginPlayback = (option: PlayerOption, allOptions: PlayerOption[], record: PlaybackRecord, resume: number) => {
    triedUrls.current = new Set([option.url]);
    triedProviders.current = new Set([record.provider]);
    setFailoverMessage(null);
    setPlaying({ option, options: allOptions, record, resume });
  };

  const start = () => {
    if (!selected || !current) return;
    const saved = getPlayback(viewer?.id ?? null).find((r) => r.mediaId === mediaId && r.episode === selected.number && r.audio === audio);
    const record: PlaybackRecord = {
      ...(saved ?? { mediaId, title, episodeId: selected.id, episode: selected.number, provider, audio, server: current.label, position: 0, duration: 0, updatedAt: Date.now() }),
      episodeId: selected.id,
      provider,
      audio,
      server: current.label,
      cover: cover ?? saved?.cover,
      expectedDuration: durationMinutes ? durationMinutes * 60 : saved?.expectedDuration,
    };
    if (saved && saved.position > 0.5) setPrompt({ option: current, options, record });
    else beginPlayback(current, options, record, 0);
  };

  const handleSelectOptionInPlayer = useCallback((nextOption: PlayerOption, currentPosition: number) => {
    setPlaying((prev) => {
      if (!prev) return prev;
      triedUrls.current.add(nextOption.url);
      setFailoverMessage(`Switched to ${prev.record.provider} · ${nextOption.label}.`);
      return {
        ...prev,
        option: nextOption,
        resume: currentPosition > 0.5 ? currentPosition : prev.resume,
        record: { ...prev.record, server: nextOption.label, position: currentPosition, updatedAt: Date.now() },
      };
    });
  }, []);

  const handleTryNextSource = useCallback((reason: string, currentPosition: number, automatic: boolean) => {
    setPlaying((currentPlaying) => {
      if (!currentPlaying) return currentPlaying;
      triedUrls.current.add(currentPlaying.option.url);
      triedProviders.current.add(currentPlaying.record.provider);

      // 1. Try another untried player on the same provider first.
      const nextSameProvider = currentPlaying.options.find((opt) => !triedUrls.current.has(opt.url));
      if (nextSameProvider) {
        triedUrls.current.add(nextSameProvider.url);
        setFailoverMessage(
          automatic
            ? `Previous player failed (${reason}). Switched to ${currentPlaying.record.provider} · ${nextSameProvider.label}.`
            : `Switched to ${currentPlaying.record.provider} · ${nextSameProvider.label}.`,
        );
        return {
          ...currentPlaying,
          option: nextSameProvider,
          resume: currentPosition > 0.5 ? currentPosition : currentPlaying.resume,
          record: { ...currentPlaying.record, server: nextSameProvider.label, position: currentPosition, updatedAt: Date.now() },
        };
      }

      // 2. Otherwise search other health-ranked providers for this episode.
      failoverAbort.current?.abort();
      const controller = new AbortController();
      failoverAbort.current = controller;
      setSwitchingSource(true);
      setFailoverMessage(
        automatic
          ? `All players on ${currentPlaying.record.provider} failed (${reason}). Trying another provider…`
          : `Checking another provider for Episode ${currentPlaying.record.episode}…`,
      );

      void refreshHealth().then((latestHealth) =>
        findFallbackProviderSources({
          mediaId,
          episodeNumber: currentPlaying.record.episode,
          audio: currentPlaying.record.audio,
          excludeProviders: triedProviders.current,
          health: latestHealth,
          signal: controller.signal,
        }),
      ).then((fallback) => {
        if (controller.signal.aborted) return;
        setSwitchingSource(false);
        if (!fallback) {
          setFailoverMessage("No other working provider was found for this episode. Try opening in browser or AnimePahe.");
          return;
        }
        const nextOption = fallback.options[0];
        triedProviders.current.add(fallback.provider);
        triedUrls.current.add(nextOption.url);
        setProvider(fallback.provider);
        setUserPickedProvider(true);
        setSelected(fallback.episode);
        setPlayer(nextOption.url);
        setFailoverMessage(`Switched provider to ${fallback.provider} · ${nextOption.label}.`);
        setPlaying((latest) => {
          if (!latest) return latest;
          return {
            option: nextOption,
            options: fallback.options,
            resume: currentPosition > 0.5 ? currentPosition : latest.resume,
            record: {
              ...latest.record,
              provider: fallback.provider,
              episodeId: fallback.episode.id,
              server: nextOption.label,
              position: currentPosition,
              updatedAt: Date.now(),
            },
          };
        });
      }).catch(() => {
        if (!controller.signal.aborted) {
          setSwitchingSource(false);
          setFailoverMessage("Could not reach fallback providers. Try opening in browser.");
        }
      });

      return currentPlaying;
    });
  }, [mediaId, refreshHealth]);

  useEffect(() => () => { failoverAbort.current?.abort(); }, []);

  useEffect(() => {
    if (request?.mediaId === mediaId && selected && options.length) {
      useAppStore.setState({ playbackRequest: null });
      const savedPlayer = options.find((option) => option.label === request.server) ?? options[0];
      const record = { ...request, server: savedPlayer.label, cover: cover ?? request.cover, expectedDuration: durationMinutes ? durationMinutes * 60 : request.expectedDuration };
      if (savedPlayer.label !== request.server) {
        setAutoFallbackNotice(`Previous player ${request.server} is unavailable; selected ${savedPlayer.label} instead.`);
      }
      if (request.position > 0.5) setPrompt({ option: savedPlayer, options, record });
      else beginPlayback(savedPlayer, options, record, 0);
    }
  }, [request, mediaId, selected, options, cover, durationMinutes]);

  const directCount = options.filter((o) => o.kind !== "embed").length;

  return <div className="mb-6 rounded-lg border border-zinc-700 bg-zinc-900 p-4">
    <h3 className="text-lg font-semibold">Episodes</h3>
    <p className="mt-1 text-sm text-zinc-400">MEGU prioritizes native Direct HLS/MP4 players and automatically switches sources if a player fails.</p>
    <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-950/50 p-3 text-xs text-zinc-300" aria-live="polite">
      <strong>Provider diagnostics</strong>
      <p className="mt-1">{episodes.isLoading ? "Checking episode availability…" : episodes.error ? "Could not reach or read the episode service. Check your connection and retry; the provider may be unavailable." : !Array.isArray(list) || !list.length ? `No ${audio} episodes were returned by ${provider}. Try another provider or audio option.` : selected && streams.isFetching ? "Checking available players…" : selected && streams.error ? "The episode list loaded, but the player request failed. Retry or choose a different provider." : selected && streams.data && !current ? "The provider returned no player MEGU can use for this episode." : selected && current ? `${options.length} player${options.length === 1 ? "" : "s"} ready${directCount > 0 ? ` (${directCount} direct stream${directCount === 1 ? "" : "s"})` : ""}; MEGU will automatically fail over if playback errors.` : `${list.length} ${audio} episodes found on ${provider}. Select one to check players.`}</p>
      {autoFallbackNotice && <p className="mt-1 text-sky-300">{autoFallbackNotice}</p>}
      <p className="mt-1 text-zinc-500">Providers are ordered by recent playback reliability on this device. Embed popups and ad redirects are blocked.</p>
    </div>
    <div className="mt-4 flex flex-wrap gap-3 text-sm">
      <label className="flex items-center gap-2">Provider <select value={provider} onChange={(e) => { setUserPickedProvider(true); setAutoFallbackNotice(null); setProvider(e.target.value as Provider); reset(); }} className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2">{rankedProviders.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
      <label className="flex items-center gap-2">Audio <select value={audio} onChange={(e) => { setAudio(e.target.value as Audio); autoProbedEpisodesFor.current = null; reset(); }} className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2"><option value="sub">Sub</option><option value="dub">Dub</option></select></label>
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
        {playing && <InlinePlayer option={playing.option} options={playing.options} onSelectOption={handleSelectOptionInPlayer} onTryNextSource={handleTryNextSource} switchingSource={switchingSource} failoverMessage={failoverMessage} record={playing.record} resume={playing.resume} onClose={() => { failoverAbort.current?.abort(); setSwitchingSource(false); setPlaying(null); void refreshHealth(); }} />}
        {prompt && <ResumePrompt record={prompt.record} onYes={() => { beginPlayback(prompt.option, prompt.options, prompt.record, prompt.record.position); setPrompt(null); }} onNo={() => { beginPlayback(prompt.option, prompt.options, prompt.record, 0); setPrompt(null); }} onCancel={() => setPrompt(null)} />}
        <p className="mt-2 text-xs text-zinc-500">If playback stalls or fails, use “Try next source” inside the player to jump to the next working server or provider without losing your place.</p>
      </>}
    </section>}
  </div>;
}
