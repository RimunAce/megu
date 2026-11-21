const API = "https://anivexa.respire.my";
// A single provider can stall indefinitely; bound every request so one hung
// provider cannot block episode lists, stream lookups, or provider failover.
export const REQUEST_TIMEOUT_MS = 12_000;
export const PROVIDERS = ["anikoto", "reanime", "mkissa", "animegg", "animenosub", "anizone", "aniwaves", "senshi", "kaa", "animedunya", "animeonsen", "anipm"] as const;
export type Provider = typeof PROVIDERS[number];
export type Audio = "sub" | "dub";
export interface Episode { id: string; number: number; title: string | null }
export interface ProviderResponse { episodes?: Partial<Record<Audio, Episode[]>>; error?: string }
export interface Stream { url?: string; embedUrl?: string; embed?: string; type?: string; server?: string; referer?: string; headers?: Record<string, string>; subtitles?: { url?: string; label?: string; language?: string; srclang?: string; format?: string; default?: boolean }[] }
export interface SubtitleTrack { url: string; label: string; language: string; format: "srt" | "vtt"; default: boolean }
export interface PlayerOption {
  url: string;
  label: string;
  kind: "embed" | "hls" | "mp4";
  referer?: string;
  origin?: string;
  userAgent?: string;
  subtitles?: SubtitleTrack[];
}

function timeoutError(): Error {
  return new Error("The episode service took too long to respond. Try again or choose another provider.");
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try { response = await fetch(`${API}${path}`, { signal: requestSignal, headers: { Accept: "application/json" } }); }
  catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted) throw timeoutError();
    throw new Error("Could not reach the Anivexa service. Check your connection and try again.");
  }
  if (!response.ok) throw new Error(`Anivexa request failed (${response.status}).`);
  try { return await response.json() as T; }
  catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted) throw timeoutError();
    throw new Error("Anivexa returned an invalid response.");
  }
}

export async function getEpisodes(mediaId: number, provider: Provider, signal?: AbortSignal): Promise<ProviderResponse> {
  if (!Number.isSafeInteger(mediaId) || mediaId < 1 || !PROVIDERS.includes(provider)) throw new Error("Invalid title or provider.");
  const response = await getJson<Record<string, unknown>>(`/episodes/${provider}/${mediaId}?map=false`, signal);
  const result = response[provider];
  if (!result || typeof result !== "object") throw new Error(typeof response.error === "string" ? response.error : "This provider did not return an episode list.");
  return result as ProviderResponse;
}

/** Only request an episode path which exactly matches the selected title and provider. */
export async function getStreams(mediaId: number, provider: Provider, audio: Audio, episode: Episode, signal?: AbortSignal): Promise<Stream[]> {
  if (!Number.isSafeInteger(mediaId) || mediaId < 1 || !PROVIDERS.includes(provider) || !["sub", "dub"].includes(audio)) throw new Error("Invalid episode selection.");
  const pattern = new RegExp(`^watch/${provider}/${mediaId}/${audio}/${provider}-[0-9]+$`);
  if (typeof episode.id !== "string" || !pattern.test(episode.id)) throw new Error("The provider returned an invalid episode link.");
  const result = await getJson<{ streams?: unknown; error?: string }>(`/${episode.id}`, signal);
  if (!Array.isArray(result.streams)) throw new Error(result.error || "No streams were returned for this episode.");
  return result.streams.filter((s): s is Stream => !!s && typeof s === "object");
}

/** Remote content is untrusted. Never allow local files, network hosts, or credentials. */
export function safeEmbedUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || url.port || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.includes(":") || /^\d+(\.\d+)*$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target && typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function parseSubtitles(stream: Stream): SubtitleTrack[] {
  if (!Array.isArray(stream.subtitles)) return [];
  const seen = new Set<string>();
  return stream.subtitles.flatMap((track) => {
    const link = safeEmbedUrl(track?.url);
    if (!link || seen.has(link)) return [];
    const rawFormat = typeof track?.format === "string" ? track.format.toLowerCase() : "";
    const pathname = new URL(link).pathname.toLowerCase();
    const format = rawFormat === "srt" || rawFormat === "vtt"
      ? rawFormat
      : pathname.endsWith(".vtt") ? "vtt" : pathname.endsWith(".srt") ? "srt" : "";
    if (!format) return [];
    seen.add(link);
    const label = typeof track.label === "string" && track.label.trim()
      ? track.label.trim()
      : typeof track.language === "string" && track.language.trim()
        ? track.language.trim()
        : "Subtitles";
    const language = typeof track.srclang === "string" && track.srclang.trim()
      ? track.srclang.trim()
      : typeof track.language === "string" && /^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(track.language.trim())
        ? track.language.trim()
        : "en";
    return [{ url: link, label, language, format: format as "srt" | "vtt", default: track.default === true }];
  });
}

export function optionHost(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/\.$/, ""); } catch { return "unknown"; }
}

export function embedOptions(streams: Stream[]): PlayerOption[] {
  const seen = new Set<string>();
  const labels = new Map<string, number>();
  const direct: PlayerOption[] = [];
  const embeds: PlayerOption[] = [];

  for (const stream of streams) {
    const type = typeof stream.type === "string" ? stream.type.toLowerCase() : "";
    const rawDirect = safeEmbedUrl(stream.url);
    const path = rawDirect ? new URL(rawDirect).pathname.toLowerCase() : "";
    const isHls = type === "hls" || type === "m3u8" || (type !== "embed" && path.endsWith(".m3u8"));
    const isMp4 = type === "mp4" || type === "webm" || path.endsWith(".mp4") || path.endsWith(".webm");
    if (rawDirect && (isHls || isMp4) && !seen.has(rawDirect)) {
      seen.add(rawDirect);
      const serverName = typeof stream.server === "string" && stream.server.trim() ? stream.server.trim() : "Player";
      const kind = isHls ? ("hls" as const) : ("mp4" as const);
      const base = `${serverName} · ${isHls ? "Direct HLS" : "Direct MP4"}`;
      const count = (labels.get(base) ?? 0) + 1;
      labels.set(base, count);
      const referer = safeEmbedUrl(stream.referer ?? headerValue(stream.headers, "referer")) ?? undefined;
      const rawOrigin = safeEmbedUrl(headerValue(stream.headers, "origin"));
      const origin = rawOrigin ? new URL(rawOrigin).origin : undefined;
      const userAgent = headerValue(stream.headers, "user-agent");
      direct.push({
        url: rawDirect,
        label: count === 1 ? base : `${base} #${count}`,
        kind,
        referer,
        origin,
        userAgent,
        subtitles: parseSubtitles(stream),
      });
    }
  }

  for (const stream of streams) {
    const url = safeEmbedUrl(stream.embedUrl ?? stream.embed ?? (stream.type === "embed" ? stream.url : null));
    if (!url || seen.has(url)) continue;
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".m3u8") || pathname.endsWith(".mp4") || pathname.endsWith(".webm")) continue;
    seen.add(url);
    const name = typeof stream.server === "string" && stream.server.trim() ? stream.server.trim() : `Player ${seen.size}`;
    const count = (labels.get(name) ?? 0) + 1;
    labels.set(name, count);
    embeds.push({ url, label: count === 1 ? name : `${name} #${count}`, kind: "embed" });
  }

  // The provider's plain /stream pages often rely on parent iframe context;
  // /videojs/ variants tend to work reliably in a top-level MEGU player webview.
  embeds.sort((a, b) => Number(!a.url.includes("/videojs/")) - Number(!b.url.includes("/videojs/")));

  // Prefer ad-free native streams before third-party embeds. Direct HLS and
  // direct MP4 both play in-app: the desktop app streams them through its
  // loopback proxy with real HTTP Range requests, so MP4 is no longer buffered whole.
  return [...direct, ...embeds];
}
