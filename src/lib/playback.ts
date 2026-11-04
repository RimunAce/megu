import { PROVIDERS, type Audio, type Provider } from "./anivexa";

export interface PlaybackRecord {
  mediaId: number;
  title: string;
  cover?: string | null;
  expectedDuration?: number | null;
  audioTrack?: string;
  subtitleTrack?: string;
  episodeId: string;
  episode: number;
  provider: Provider;
  audio: Audio;
  server: string;
  position: number;
  duration: number;
  updatedAt: number;
}

const key = (userId: number | null) => `megu.playback.v1.${userId ?? "guest"}`;
export function getPlayback(userId: number | null): PlaybackRecord[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(key(userId)) ?? "[]");
    if (!Array.isArray(data)) return [];
    return data.filter((r): r is PlaybackRecord => r && Number.isSafeInteger(r.mediaId) && r.mediaId > 0 && typeof r.episodeId === "string" && typeof r.title === "string" && Number.isFinite(r.position) && r.position >= 0 && Number.isFinite(r.duration) && r.duration > 0 && r.position <= r.duration + 1 && Number.isFinite(r.episode) && PROVIDERS.includes(r.provider) && (r.audio === "sub" || r.audio === "dub") && typeof r.server === "string" && !!r.server);
  } catch { return []; }
}
export function savePlayback(userId: number | null, record: PlaybackRecord) {
  const rest = getPlayback(userId).filter((r) => !(r.mediaId === record.mediaId && r.episodeId === record.episodeId && r.provider === record.provider && r.audio === record.audio && r.server === record.server));
  localStorage.setItem(key(userId), JSON.stringify([record, ...rest].slice(0, 300)));
  window.dispatchEvent(new Event("megu-playback-changed"));
}
export function formatTime(seconds: number) {
  const n = Math.max(0, Math.floor(seconds));
  const h = Math.floor(n / 3600);
  const m = Math.floor(n / 60) % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}` : `${m}:${String(n % 60).padStart(2, "0")}`;
}
