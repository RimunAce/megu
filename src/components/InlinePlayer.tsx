import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { queueAutoSync } from "../lib/autoSync";
import { savePlayback, type PlaybackRecord } from "../lib/playback";
import { useAuthStore } from "../store/app";
import { motion } from "framer-motion";
import DirectHlsPlayer from "./DirectHlsPlayer";
import type { PlayerOption } from "../lib/anivexa";
import { recordProviderOutcome } from "../lib/providerHealth";
import { openStreamUrl } from "../lib/tauri";

// Serialize lifecycle operations so a slow WebView2 creation cannot outlive
// its component or race a subsequent player selection.
let playerOperations: Promise<void> = Promise.resolve();
function enqueue(operation: () => Promise<void>) {
  const next = playerOperations.catch(() => {}).then(operation);
  playerOperations = next;
  return next;
}

export interface InlinePlayerProps {
  option: PlayerOption;
  options: PlayerOption[];
  onSelectOption: (option: PlayerOption, currentPosition: number) => void;
  onTryNextSource: (reason: string, currentPosition: number, automatic: boolean) => void;
  switchingSource?: boolean;
  failoverMessage?: string | null;
  onClose: () => void;
  record: PlaybackRecord;
  resume: number;
}

export default function InlinePlayer({
  option,
  options,
  onSelectOption,
  onTryNextSource,
  switchingSource = false,
  failoverMessage = null,
  onClose,
  record,
  resume,
}: InlinePlayerProps) {
  const area = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const session = useRef(crypto.randomUUID());
  const startedAt = useRef(0);
  const recordedOutcome = useRef(false);
  const latestPosition = useRef(resume);
  const failoverFired = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ message: string; kind: string } | null>(null);
  const [tracking, setTracking] = useState(false);
  const [trackingSlow, setTrackingSlow] = useState(false);
  const [challengeDetected, setChallengeDetected] = useState(false);
  const [ignoreDurationHint, setIgnoreDurationHint] = useState(false);
  const token = useAuthStore((s) => s.token);
  const viewer = useAuthStore((s) => s.viewer);
  const progressHandler = useRef<(progress: { time: number; duration: number; paused: boolean }) => void>(() => {});
  const audioTrack = useRef(record.audioTrack);
  const subtitleTrack = useRef(record.subtitleTrack);
  const [optionKey, setOptionKey] = useState(option.url);
  if (optionKey !== option.url) {
    setOptionKey(option.url);
    setError(null);
    setTracking(false);
    setTrackingSlow(false);
    setChallengeDetected(false);
  }

  useEffect(() => {
    startedAt.current = Date.now();
    recordedOutcome.current = false;
    failoverFired.current = false;
    latestPosition.current = resume;
  }, [option, resume]);

  const markSuccess = useCallback(() => {
    if (recordedOutcome.current) return;
    recordedOutcome.current = true;
    void recordProviderOutcome(record.provider, option.url, true, Date.now() - startedAt.current);
  }, [record.provider, option.url]);

  const triggerFailover = useCallback((reason: string, automatic: boolean) => {
    if (automatic && failoverFired.current) return;
    failoverFired.current = true;
    if (!recordedOutcome.current) {
      recordedOutcome.current = true;
      void recordProviderOutcome(record.provider, option.url, false);
    }
    onTryNextSource(reason, latestPosition.current, automatic);
  }, [record.provider, option.url, onTryNextSource]);

  const onDirectProgress = useCallback((progress: { time: number; duration: number; paused: boolean }) => progressHandler.current(progress), []);
  const onAudioChange = useCallback((track: string) => { audioTrack.current = track; }, []);
  const onSubtitleChange = useCallback((track: string) => { subtitleTrack.current = track; }, []);
  const onDirectError = useCallback((message: string) => {
    setError(message);
    triggerFailover(message, true);
  }, [triggerFailover]);

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
    }).catch((e: unknown) => {
      if (!controller.signal.aborted) {
        const msg = String(e);
        setError(msg);
        triggerFailover(msg, true);
      }
    });
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
  }, [option, resume, record.expectedDuration, ignoreDurationHint, triggerFailover]);

  useEffect(() => {
    const controller = new AbortController();
    let unlistenProgress: (() => void) | undefined;
    let unlistenHealth: (() => void) | undefined;
    let syncStarted = false;
    let lastTime = -1;
    let lastWall = 0;
    let watched = 0;
    const timer = window.setTimeout(() => setTrackingSlow(true), 12000);
    const handle = ({ time, duration, paused }: { time: number; duration: number; paused: boolean }) => {
      if (controller.signal.aborted || !Number.isFinite(time) || !Number.isFinite(duration) || typeof paused !== "boolean" || duration < 1 || duration > 86400 || time < 0 || time > duration + 1) return;
      setTracking(true);
      setChallengeDetected(false);
      latestPosition.current = time;
      markSuccess();
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
    if (isTauri() && option.kind === "embed") {
      void listen<{ session: string; time: number; duration: number; paused: boolean }>("player-progress", (event) => {
        if (event.payload?.session === session.current) handle(event.payload);
      }).then((dispose) => { if (!controller.signal.aborted) unlistenProgress = dispose; else dispose(); }).catch((e: unknown) => { if (!controller.signal.aborted) setError(String(e)); });

      void listen<{ session: string; state: string; detail?: string }>("player-health", (event) => {
        if (controller.signal.aborted || event.payload?.session !== session.current) return;
        if (event.payload.state === "challenge") {
          setChallengeDetected(true);
        } else if (event.payload.state === "dead") {
          const reason = event.payload.detail || "Embed player failed to load";
          setError(reason);
          triggerFailover(reason, true);
        }
      }).then((dispose) => { if (!controller.signal.aborted) unlistenHealth = dispose; else dispose(); }).catch(() => {});
    }
    return () => {
      controller.abort();
      progressHandler.current = () => {};
      clearTimeout(timer);
      unlistenProgress?.();
      unlistenHealth?.();
    };
  }, [record, token, viewer, ignoreDurationHint, option.kind, markSuccess, triggerFailover]);

  const kindLabel = option.kind === "hls" ? "Direct HLS" : "Embed";

  return <div ref={dialog} className="fixed inset-0 z-[100] flex flex-col bg-black" role="dialog" aria-modal="true" aria-label="Episode player">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 bg-zinc-900 px-4 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-3 text-sm">
        <span className="font-semibold">MEGU player</span>
        <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">{record.provider} · {kindLabel}</span>
        {options.length > 1 && <select
          aria-label="Switch player server"
          value={option.url}
          disabled={switchingSource}
          onChange={(e) => {
            const next = options.find((item) => item.url === e.target.value);
            if (next) onSelectOption(next, latestPosition.current);
          }}
          className="max-w-52 rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-xs text-zinc-100 disabled:opacity-50"
        >
          {options.map((item) => <option key={item.url} value={item.url}>{item.label}</option>)}
        </select>}
        <button
          disabled={switchingSource}
          onClick={() => triggerFailover("Switched manually", false)}
          className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
        >
          {switchingSource ? "Finding working source…" : "Try next source"}
        </button>
        <button
          onClick={() => void openStreamUrl(option.url).catch((e: unknown) => setError(String(e)))}
          className="text-xs text-zinc-400 underline hover:text-zinc-200"
        >
          Open in browser ↗
        </button>
      </div>
      <button onClick={onClose} className="rounded bg-zinc-700 px-4 py-1.5 text-sm hover:bg-zinc-600">Close player</button>
    </div>
    {(notice || error || failoverMessage || challengeDetected || (trackingSlow && !tracking)) && (
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-zinc-800 bg-zinc-950 px-4 py-1.5 text-xs">
        {failoverMessage && <span role="status" className="text-sky-300">{failoverMessage}</span>}
        {notice && <motion.span initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} role="status" className={notice.kind === "error" ? "text-amber-300" : "text-emerald-300"}>{notice.message}</motion.span>}
        {challengeDetected && !tracking && <span role="status" className="text-amber-300">Provider verification detected — complete the check inside the player, or click “Try next source”.</span>}
        {error && <span role="alert" className="text-red-300">{error}</span>}
        {trackingSlow && !tracking && !error && !challengeDetected && (
          <span role="status" className="text-amber-300">
            No playback detected yet. Try next source if the player looks stuck.
            {option.kind === "embed" && !ignoreDurationHint && record.expectedDuration ? (
              <>{" "}<button onClick={() => { setIgnoreDurationHint(true); setTrackingSlow(false); }} className="underline">Retry without duration check</button></>
            ) : null}
          </span>
        )}
      </div>
    )}
    <div ref={area} className="relative min-h-0 flex-1 bg-black">
      {error && option.kind !== "embed" && <p role="alert" className="p-4 text-sm text-red-300">{error}</p>}
      {option.kind === "hls"
        ? <DirectHlsPlayer key={`${option.url}:${resume}`} option={option} resume={resume} audio={record.audio} savedAudioTrack={record.audioTrack} savedSubtitleTrack={record.subtitleTrack} onAudioChange={onAudioChange} onSubtitleChange={onSubtitleChange} onProgress={onDirectProgress} onError={onDirectError} />
        : !isTauri() && <iframe src={option.url} title="Episode player" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen className="size-full border-0" />}
    </div>
  </div>;
}
