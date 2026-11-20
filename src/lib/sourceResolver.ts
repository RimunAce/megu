import { embedOptions, getEpisodes, getStreams, PROVIDERS, type Audio, type Episode, type PlayerOption, type Provider } from "./anivexa";
import { rankPlayerOptions, rankProviders, type ProviderHealthEntry } from "./providerHealth";

export interface ResolvedSource {
  provider: Provider;
  episode: Episode;
  option: PlayerOption;
}

export interface ProviderEpisodeProbe {
  provider: Provider;
  episodes: Episode[];
}

/**
 * Find the best next source for an episode across other providers when the
 * current provider's players have all failed or when the user asks to switch.
 */
export async function findFallbackProviderSources(params: {
  mediaId: number;
  episodeNumber: number;
  audio: Audio;
  excludeProviders: Iterable<Provider>;
  health: ProviderHealthEntry[];
  maxAttempts?: number;
  signal?: AbortSignal;
}): Promise<{ provider: Provider; episode: Episode; options: PlayerOption[] } | null> {
  const { mediaId, episodeNumber, audio, excludeProviders, health, maxAttempts = 5, signal } = params;
  const excluded = new Set(excludeProviders);
  const candidates = rankProviders(
    PROVIDERS.filter((p) => !excluded.has(p)),
    health,
  ).slice(0, maxAttempts);

  for (const provider of candidates) {
    if (signal?.aborted) return null;
    try {
      const epResp = await getEpisodes(mediaId, provider, signal);
      const list = epResp.episodes?.[audio];
      if (!Array.isArray(list) || list.length === 0) continue;
      const match = list.find((ep) => ep && Number.isFinite(ep.number) && Math.abs(ep.number - episodeNumber) < 0.001);
      if (!match) continue;
      const streams = await getStreams(mediaId, provider, audio, match, signal);
      const ranked = rankPlayerOptions(provider, embedOptions(streams), health);
      if (ranked.length > 0) {
        return { provider, episode: match, options: ranked };
      }
    } catch {
      if (signal?.aborted) return null;
      // Try the next ranked provider.
    }
  }
  return null;
}

/**
 * Probe providers in health-ranked order until one returns an episode list for
 * the requested audio track. Used when the currently selected provider returns
 * empty or errors so the user gets episodes automatically.
 */
export async function findAvailableProviderForEpisodes(params: {
  mediaId: number;
  audio: Audio;
  excludeProviders: Iterable<Provider>;
  health: ProviderHealthEntry[];
  maxAttempts?: number;
  signal?: AbortSignal;
}): Promise<ProviderEpisodeProbe | null> {
  const { mediaId, audio, excludeProviders, health, maxAttempts = 4, signal } = params;
  const excluded = new Set(excludeProviders);
  const candidates = rankProviders(
    PROVIDERS.filter((p) => !excluded.has(p)),
    health,
  ).slice(0, maxAttempts);

  for (const provider of candidates) {
    if (signal?.aborted) return null;
    try {
      const epResp = await getEpisodes(mediaId, provider, signal);
      const list = epResp.episodes?.[audio];
      if (Array.isArray(list) && list.length > 0) {
        return { provider, episodes: list };
      }
    } catch {
      if (signal?.aborted) return null;
    }
  }
  return null;
}
