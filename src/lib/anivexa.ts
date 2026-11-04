const API = "https://anivexa.respire.my";
export const PROVIDERS = ["anikoto", "reanime", "mkissa", "animegg", "animenosub", "anizone", "aniwaves", "senshi", "kaa", "animedunya", "animeonsen", "anipm"] as const;
export type Provider = typeof PROVIDERS[number];
export type Audio = "sub" | "dub";
export interface Episode { id: string; number: number; title: string | null }
interface ProviderResponse { episodes?: Partial<Record<Audio, Episode[]>>; error?: string }
interface Stream { url?: string; embedUrl?: string; embed?: string; type?: string; server?: string; referer?: string; headers?: Record<string, string>; subtitles?: { url?: string; label?: string; language?: string; srclang?: string; format?: string; default?: boolean }[] }
export interface PlayerOption { url: string; label: string; kind: "embed" | "hls"; referer?: string; subtitles?: { url: string; label: string; language: string; format: "srt" | "vtt"; default: boolean }[] }

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try { response = await fetch(`${API}${path}`, { signal, headers: { Accept: "application/json" } }); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("Could not reach the Anivexa service. Check your connection and try again.");
  }
  if (!response.ok) throw new Error(`Anivexa request failed (${response.status}).`);
  try { return await response.json() as T; }
  catch { throw new Error("Anivexa returned an invalid response."); }
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

export function embedOptions(streams: Stream[]): PlayerOption[] {
  const seen = new Set<string>();
  const labels = new Map<string, number>();
  const options = streams.flatMap((stream) => {
    const url = safeEmbedUrl(stream.embedUrl ?? stream.embed ?? (stream.type === "embed" ? stream.url : null));
    if (!url || new URL(url).pathname.toLowerCase().endsWith(".m3u8") || seen.has(url)) return [];
    seen.add(url);
    const name = typeof stream.server === "string" && stream.server.trim() ? stream.server.trim() : `Player ${seen.size}`;
    const count = (labels.get(name) ?? 0) + 1;
    labels.set(name, count);
    return [{ url, label: count === 1 ? name : `${name} #${count}`, kind: "embed" as const }];
  });
  // The provider's plain /stream pages only work inside its own iframe; the
  // /videojs/ variant is the one that plays in a top-level MEGU player window.
  options.sort((a, b) => Number(!a.url.includes("/videojs/")) - Number(!b.url.includes("/videojs/")));
  const direct: PlayerOption[] = [];
  for (const stream of streams) {
    if (stream.type !== "hls") continue;
    const url = safeEmbedUrl(stream.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const base = `${typeof stream.server === "string" && stream.server.trim() ? stream.server.trim() : "Player"} · Direct HLS`;
    const count = (labels.get(base) ?? 0) + 1; labels.set(base, count);
    const subtitles = Array.isArray(stream.subtitles) ? stream.subtitles.flatMap((track) => {
      const link = safeEmbedUrl(track?.url);
      const format = typeof track?.format === "string" ? track.format.toLowerCase() : "";
      if (!link || !["srt", "vtt"].includes(format) || new URL(link).host !== new URL(url).host) return [];
      const label = typeof track.label === "string" ? track.label : typeof track.language === "string" ? track.language : "Subtitles";
      const language = typeof track.srclang === "string" ? track.srclang : "en";
      return [{ url: link, label, language, format: format as "srt" | "vtt", default: track.default === true }];
    }) : [];
    direct.push({ url, label: count === 1 ? base : `${base} #${count}`, kind: "hls", referer: safeEmbedUrl(stream.referer ?? stream.headers?.Referer ?? stream.headers?.referer) ?? undefined, subtitles });
  }
  return [...options, ...direct];
}
