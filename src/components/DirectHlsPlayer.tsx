import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { LoaderCallbacks, LoaderConfiguration, LoaderContext, LoaderStats } from "hls.js";
import type { Audio, PlayerOption } from "../lib/anivexa";

type VideoProgress = { time: number; duration: number; paused: boolean };

export default function DirectHlsPlayer({ option, resume, audio, savedAudioTrack, savedSubtitleTrack, onAudioChange, onSubtitleChange, onProgress, onError }: { option: PlayerOption; resume: number; audio: Audio; savedAudioTrack?: string; savedSubtitleTrack?: string; onAudioChange: (track: string) => void; onSubtitleChange: (track: string) => void; onProgress: (progress: VideoProgress) => void; onError: (message: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<import("hls.js").default | null>(null);
  const seekConfirmed = useRef(resume <= 0);
  const userChoseAudio = useRef(false);
  const [audioTracks, setAudioTracks] = useState<{ id: number; name: string }[]>([]);
  const [selectedAudio, setSelectedAudio] = useState(0);
  const [subtitle, setSubtitle] = useState<{ src: string; label: string; language: string } | null>(null);
  const [subtitleError, setSubtitleError] = useState<string | null>(null);
  const [subtitleSession, setSubtitleSession] = useState<string | null>(null);
  const [selectedSubtitle, setSelectedSubtitle] = useState(() => {
    const tracks = option.subtitles ?? [];
    if (savedSubtitleTrack === "off") return -1;
    const saved = tracks.findIndex((track) => track.label === savedSubtitleTrack);
    if (saved >= 0) return saved;
    if (audio === "dub") return -1;
    const english = tracks.findIndex((track) => /^en/i.test(track.language) || /english/i.test(track.label));
    return english >= 0 ? english : tracks.findIndex((track) => track.default);
  });

  useEffect(() => {
    const streamSession = crypto.randomUUID();
    let disposed = false;
    let registered = false;
    let hls: import("hls.js").default | null = null;
    const start = async () => {
      const media = video.current;
      if (!media) return;
      if (isTauri()) {
        await invoke("register_stream", { session: streamSession, url: option.url, referer: option.referer ?? null });
        registered = true;
        if (disposed) { await invoke("close_stream", { session: streamSession }); return; }
      }
      const module = await import("hls.js");
      const Hls = module.default;
      if (disposed) return;
      if (!Hls.isSupported()) throw new Error("This WebView cannot play HLS video.");

      class TauriLoader {
        context: LoaderContext | null = null;
        stats: LoaderStats = new module.LoadStats();
        private aborted = false;
        private timer: ReturnType<typeof setTimeout> | null = null;
        destroy() { this.abort(); }
        abort() { this.aborted = true; this.stats.aborted = true; if (this.timer) clearTimeout(this.timer); }
        load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
          this.context = context;
          this.stats.loading.start = performance.now();
          this.timer = setTimeout(() => { if (!this.aborted) { this.aborted = true; callbacks.onTimeout(this.stats, context, null); } }, config.loadPolicy.maxLoadTimeMs || 45000);
          const start = context.rangeStart;
          const end = context.rangeEnd;
          const bounded = typeof start === "number" && typeof end === "number" && end > start;
          const openEnded = typeof start === "number" && start > 0 && (end === undefined || end === 0);
          void invoke<ArrayBuffer>("fetch_stream", { session: streamSession, url: context.url, rangeStart: bounded || openEnded ? start : null, rangeEnd: bounded ? end : null }).then((buffer) => {
            if (this.aborted) return;
            if (this.timer) clearTimeout(this.timer);
            this.stats.loading.first = this.stats.loading.end = performance.now();
            this.stats.loaded = this.stats.total = buffer.byteLength;
            const data = context.responseType === "arraybuffer" ? buffer : new TextDecoder().decode(buffer);
            callbacks.onSuccess({ url: context.url, data }, this.stats, context, null);
          }).catch((error: unknown) => {
            if (this.aborted) return;
            if (this.timer) clearTimeout(this.timer);
            callbacks.onError({ code: 0, text: String(error) }, context, null, this.stats);
          });
        }
      }

      hls = new Hls({ ...(isTauri() ? { loader: TauriLoader } : {}), startPosition: resume > 0 ? resume : -1 });
      hlsRef.current = hls;
      hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal && !disposed) onError(`Direct stream failed: ${data.response?.text || data.details}. Try another player.`); });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, (_event, data) => {
        if (disposed || !hls) return;
        const tracks = data.audioTracks.map((track, id) => ({ id, name: track.name || track.lang || `Audio ${id + 1}` }));
        setAudioTracks(tracks);
        const saved = savedAudioTrack ? tracks.findIndex((track) => track.name === savedAudioTrack) : -1;
        const preferred = saved >= 0 ? saved : data.audioTracks.findIndex((track) => audio === "dub" ? /^(en|eng)(-|$)/i.test(track.lang || "") : /^(ja|jpn)(-|$)/i.test(track.lang || ""));
        if (!userChoseAudio.current && preferred >= 0) { hls.audioTrack = preferred; setSelectedAudio(preferred); onAudioChange(tracks[preferred].name); }
      });
      hls.attachMedia(media);
      hls.loadSource(option.url);
      setSubtitleSession(streamSession);
      const seek = () => { if (resume > 0 && Number.isFinite(media.duration) && media.duration > resume && media.seekable.length) { media.currentTime = resume; media.removeEventListener("canplay", seek); } };
      media.addEventListener("canplay", seek);
      void media.play().catch(() => {});

    };
    void start().catch((error: unknown) => { if (!disposed) onError(error instanceof Error ? error.message : String(error)); });
    return () => {
      disposed = true;
      hls?.destroy(); hlsRef.current = null;
      if (registered) void invoke("close_stream", { session: streamSession }).catch(() => {});
    };
  }, [option, resume, audio, savedAudioTrack, onAudioChange, onError]);

  useEffect(() => {
    const track = option.subtitles?.[selectedSubtitle];
    if (!track || !subtitleSession) return;
    let disposed = false;
    let blob: string | null = null;
    const load = async () => {
      const data = isTauri() ? await invoke<ArrayBuffer>("fetch_stream", { session: subtitleSession, url: track.url, rangeStart: null, rangeEnd: null }) : await fetch(track.url).then((response) => { if (!response.ok) throw new Error("Subtitle request failed"); return response.arrayBuffer(); });
      if (data.byteLength > 2 * 1024 * 1024) throw new Error("Subtitle file is too large");
      let text = new TextDecoder().decode(data).replace(/^\uFEFF/, "");
      if (track.format === "srt") text = `WEBVTT\n\n${text.replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2")}`;
      if (!disposed) { blob = URL.createObjectURL(new Blob([text], { type: "text/vtt" })); setSubtitle({ src: blob, label: track.label, language: /^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(track.language) ? track.language : "en" }); }
    };
    void load().catch(() => { if (!disposed) setSubtitleError("Could not load the selected subtitles."); });
    return () => { disposed = true; if (blob) URL.revokeObjectURL(blob); };
  }, [option.subtitles, selectedSubtitle, subtitleSession]);

  const progress = () => {
    const media = video.current;
    if (!media || !Number.isFinite(media.duration)) return;
    if (!seekConfirmed.current) {
      if (Math.abs(media.currentTime - resume) > 2) return;
      seekConfirmed.current = true;
    }
    onProgress({ time: media.currentTime, duration: media.duration, paused: media.paused });
  };
  return <div className="flex size-full min-h-0 flex-col bg-black">
    {(audioTracks.length > 1 || !!option.subtitles?.length) && <div className="flex shrink-0 flex-wrap items-center gap-4 bg-zinc-900 px-4 py-2 text-sm">{audioTracks.length > 1 && <label>Audio <select value={selectedAudio} onChange={(e) => { const id = Number(e.target.value); userChoseAudio.current = true; if (hlsRef.current) hlsRef.current.audioTrack = id; setSelectedAudio(id); const selected = audioTracks.find((track) => track.id === id); if (selected) onAudioChange(selected.name); progress(); }} className="ml-2 rounded bg-zinc-800 px-2 py-1">{audioTracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}</select></label>}{!!option.subtitles?.length && <label>Subtitles <select value={selectedSubtitle} onChange={(e) => { const index = Number(e.target.value); setSubtitle(null); setSubtitleError(null); setSelectedSubtitle(index); onSubtitleChange(index < 0 ? "off" : option.subtitles![index].label); progress(); }} className="ml-2 max-w-48 rounded bg-zinc-800 px-2 py-1"><option value={-1}>Off</option>{option.subtitles.map((track, index) => <option key={`${track.url}-${index}`} value={index}>{track.label}</option>)}</select></label>}{subtitleError && <span role="status" className="text-amber-300">{subtitleError}</span>}</div>}
    <video ref={video} controls playsInline onTimeUpdate={progress} onPause={progress} onSeeked={progress} onEnded={progress} className="min-h-0 w-full flex-1" crossOrigin="anonymous">{subtitle && <track key={subtitle.src} kind="subtitles" src={subtitle.src} srcLang={subtitle.language} label={subtitle.label} default />}</video>
  </div>;
}
