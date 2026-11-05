import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { queueAutoSync } from "../lib/autoSync";
import { savePlayback, type PlaybackRecord } from "../lib/playback";
import { useAuthStore } from "../store/app";
import { motion } from "framer-motion";
import DirectHlsPlayer from "./DirectHlsPlayer";
import type { PlayerOption } from "../lib/anivexa";

// Serialize lifecycle operations so a slow WebView2 creation cannot outlive
// its component or race a subsequent player selection.
let playerOperations: Promise<void> = Promise.resolve();
function enqueue(operation: () => Promise<void>) {
  const next = playerOperations.catch(() => {}).then(operation);
  playerOperations = next;
  return next;
}

export default function InlinePlayer({ option, onClose, record, resume }: { option: PlayerOption; onClose: () => void; record: PlaybackRecord; resume: number }) {
  const area = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const session = useRef(crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; kind: string } | null>(null);
  const [tracking, setTracking] = useState(false);
  const [trackingSlow, setTrackingSlow] = useState(false);
  const [ignoreDurationHint, setIgnoreDurationHint] = useState(false);
  const token = useAuthStore((s) => s.token);
  const viewer = useAuthStore((s) => s.viewer);
  const progressHandler = useRef<(progress: { time: number; duration: number; paused: boolean }) => void>(() => {});
  const audioTrack = useRef(record.audioTrack);
  const subtitleTrack = useRef(record.subtitleTrack);
  const onDirectProgress = useCallback((progress: { time: number; duration: number; paused: boolean }) => progressHandler.current(progress), []);
  const onAudioChange = useCallback((track: string) => { audioTrack.current = track; }, []);
  const onSubtitleChange = useCallback((track: string) => { subtitleTrack.current = track; }, []);
  const onDirectError = useCallback((message: string) => setError(message), []);

  useEffect(() => {
    const previousFullscreen: { value: boolean | null } = { value: null };
    const player = dialog.current;
    if (isTauri()) void enqueue(async () => { previousFullscreen.value = await invoke<boolean>("player_fullscreen_state"); }).catch(() => {});
    return () => {
      const exitFullscreen = async () => {
        if (document.fullscreenElement && player?.contains(document.fullscreenElement)) await document.exitFullscreen();
      };
      if (!isTauri()) { void exitFullscreen().catch(() => {}); return; }
      if (isTauri()) void enqueue(async () => {
        await exitFullscreen().catch(() => {});
        await invoke("close_inline_player");
        if (previousFullscreen.value !== null) await invoke("restore_player_fullscreen", { wasFullscreen: previousFullscreen.value });
      }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onNotice = (event: Event) => setNotice((event as CustomEvent<{ message: string; kind: string }>).detail);
    window.addEventListener("megu-sync-notice", onNotice);
    return () => window.removeEventListener("megu-sync-notice", onNotice);
  }, []);

  useEffect(() => {
    if (!isTauri() || option.kind !== "embed") return;
    const controller = new AbortController();
    const playerSession = crypto.randomUUID();
    session.current = playerSession;
    const bounds = () => {
      const rect = area.current?.getBoundingClientRect();
      return rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const initial = bounds();
    if (!initial) return;
    void enqueue(async () => {
      if (!controller.signal.aborted) await invoke("show_inline_player", { url: option.url, bounds: initial, resume, session: playerSession, expectedDuration: ignoreDurationHint ? null : (record.expectedDuration ?? null) });
    }).catch((e: unknown) => { if (!controller.signal.aborted) setError(String(e)); });
    const resize = () => {
      const current = bounds();
      if (current) void enqueue(async () => { if (!controller.signal.aborted) await invoke("resize_inline_player", { bounds: current }); }).catch(() => {});
    };
    const observer = new ResizeObserver(resize);
    if (area.current) observer.observe(area.current);
    window.addEventListener("resize", resize);
    return () => {
      controller.abort();
      observer.disconnect();
      window.removeEventListener("resize", resize);
      void enqueue(() => invoke("close_inline_player")).catch(() => {});
    };
  }, [option, resume, record.expectedDuration, ignoreDurationHint]);

  useEffect(() => {
    const controller = new AbortController();
    let unlisten: (() => void) | undefined;
    let syncStarted = false;
    let lastTime = -1;
    let lastWall = 0;
    let watched = 0;
    const timer = window.setTimeout(() => setTrackingSlow(true), 20000);
    const handle = ({ time, duration, paused }: { time: number; duration: number; paused: boolean }) => {
      if (controller.signal.aborted || !Number.isFinite(time) || !Number.isFinite(duration) || typeof paused !== "boolean" || duration < 1 || duration > 86400 || time < 0 || time > duration + 1) return;
      setTracking(true);
      // Merely opening a paused player should not create a watch-history item.
      if (time <= 0 && paused) return;
      const now = Date.now();
      const elapsed = (now - lastWall) / 1000;
      if (!paused && lastTime >= 0 && time > lastTime && elapsed > 0.2 && elapsed < 8 && time - lastTime <= elapsed * 2 + 0.5) watched += Math.min(time - lastTime, elapsed);
      lastTime = time;
      lastWall = now;
      try { savePlayback(viewer?.id ?? null, { ...record, audioTrack: audioTrack.current, subtitleTrack: subtitleTrack.current, position: time, duration, updatedAt: Date.now() }); }
      catch { setError("Could not save playback position on this device."); }
      const enoughPlayback = watched >= Math.min(2, duration * 0.01) || (time >= duration - 1 && watched > 0);
      if (syncStarted || (paused && time < duration - 1) || !enoughPlayback || time / duration < 0.9 || !Number.isSafeInteger(record.episode) || record.episode < 1 || localStorage.getItem("megu.autoSync") === "false") return;
      if (!token || !viewer) {
        syncStarted = true;
        setNotice({ message: "Sign in to AniList to sync future episode progress.", kind: "error" });
        return;
      }
      try {
        queueAutoSync(viewer.id, { mediaId: record.mediaId, episode: record.episode, title: record.title });
        syncStarted = true;
      } catch { setError("Could not queue the AniList update on this device."); }
    };
    progressHandler.current = handle;
    if (isTauri() && option.kind === "embed") void listen<{ session: string; time: number; duration: number; paused: boolean }>("player-progress", (event) => {
      if (event.payload?.session === session.current) handle(event.payload);
    }).then((dispose) => { if (!controller.signal.aborted) unlisten = dispose; else dispose(); }).catch((e: unknown) => { if (!controller.signal.aborted) setError(String(e)); });
    return () => { controller.abort(); progressHandler.current = () => {}; clearTimeout(timer); unlisten?.(); };
  }, [record, token, viewer, ignoreDurationHint, option.kind]);

  return <div ref={dialog} className="fixed inset-0 z-[100] flex flex-col bg-black" role="dialog" aria-modal="true" aria-label="Episode player">
    <div className="flex shrink-0 items-center justify-between gap-4 bg-zinc-900 px-4 py-3">
      <span className="min-w-0 text-sm font-semibold">MEGU player {notice && <motion.span initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} role="status" className={`ml-3 inline-block ${notice.kind === "error" ? "text-amber-300" : "text-emerald-300"}`}>{notice.message}</motion.span>}{error && <span role="alert" className="ml-3 text-red-300">{error}</span>}{trackingSlow && !tracking && !error && <span role="status" className="ml-3 text-amber-300">Waiting for playback data; resume may not be available for this player. {option.kind === "embed" && !ignoreDurationHint && record.expectedDuration && <button onClick={() => { setIgnoreDurationHint(true); setTrackingSlow(false); }} className="underline">Retry without duration check</button>}</span>}</span>
      <button onClick={onClose} className="rounded bg-zinc-700 px-4 py-2 text-sm hover:bg-zinc-600">Close player</button>
    </div>
    <div ref={area} className="relative min-h-0 flex-1 bg-black">
      {error && <p role="alert" className="p-4 text-red-300">{error}</p>}
      {option.kind === "hls" ? <DirectHlsPlayer option={option} resume={resume} audio={record.audio} savedAudioTrack={record.audioTrack} savedSubtitleTrack={record.subtitleTrack} onAudioChange={onAudioChange} onSubtitleChange={onSubtitleChange} onProgress={onDirectProgress} onError={onDirectError} /> : !isTauri() && <iframe src={option.url} title="Episode player" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen className="size-full border-0" />}
    </div>
  </div>;
}
