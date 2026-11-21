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

// Probe several providers at once: one stalled or unmapped provider must not
// delay reaching a provider that actually has the episode. The first probe to
// return a usable result wins and the remaining in-flight probes are aborted.
const PROBE_CONCURRENCY = 4;

async function raceFirst<T, R>(
  items: readonly T[],
  probe: (item: T, signal: AbortSignal) => Promise<R | null>,
  signal?: AbortSignal,
): Promise<R | null> {
  const internal = new AbortController();
  const linked = signal ? AbortSignal.any([signal, internal.signal]) : internal.signal;
  let next = 0;
  let winner: R | null = null;
  const worker = async (): Promise<void> => {
    while (winner === null && !linked.aborted) {
      const index = next++;
      if (index >= items.length) return;
      let result: R | null = null;
      try {
        result = await probe(items[index], linked);
      } catch {
        if (linked.aborted) return;
        result = null;
      }
      if (result !== null && winner === null) {
        winner = result;
        internal.abort();
      }
    }
  };
  const count = Math.max(1, Math.min(PROBE_CONCURRENCY, items.length));
  await Promise.all(Array.from({ length: count }, () => worker()));
  if (signal?.aborted) return null;
  return winner;
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
  const { mediaId, episodeNumber, audio, excludeProviders, health, maxAttempts = PROVIDERS.length, signal } = params;
  const excluded = new Set(excludeProviders);
  const candidates = rankProviders(
    PROVIDERS.filter((p) => !excluded.has(p)),
    health,
  ).slice(0, maxAttempts);

  return raceFirst(candidates, async (provider, probeSignal) => {
    const epResp = await getEpisodes(mediaId, provider, probeSignal);
    const list = epResp.episodes?.[audio];
    if (!Array.isArray(list) || list.length === 0) return null;
    const match = list.find((ep) => ep && Number.isFinite(ep.number) && Math.abs(ep.number - episodeNumber) < 0.001);
    if (!match) return null;
    const streams = await getStreams(mediaId, provider, audio, match, probeSignal);
    const ranked = rankPlayerOptions(provider, embedOptions(streams), health);
    if (ranked.length === 0) return null;
    return { provider, episode: match, options: ranked };
  }, signal);
}

/**
 * Probe providers until one returns an episode list for the requested audio
 * track. Used when the currently selected provider returns empty or errors so
 * the user gets episodes automatically.
 */
export async function findAvailableProviderForEpisodes(params: {
  mediaId: number;
  audio: Audio;
  excludeProviders: Iterable<Provider>;
  health: ProviderHealthEntry[];
  expectedEpisodes?: number | null;
  maxAttempts?: number;
  signal?: AbortSignal;
}): Promise<ProviderEpisodeProbe | null> {
  const { mediaId, audio, excludeProviders, health, expectedEpisodes, maxAttempts = PROVIDERS.length, signal } = params;
  const excluded = new Set(excludeProviders);
  const candidates = rankProviders(
    PROVIDERS.filter((p) => !excluded.has(p)),
    health,
  ).slice(0, maxAttempts);

  const targetCount = typeof expectedEpisodes === "number" && expectedEpisodes > 0 ? expectedEpisodes : null;
  if (!targetCount) {
    return raceFirst(candidates, async (provider, probeSignal) => {
      const epResp = await getEpisodes(mediaId, provider, probeSignal);
      const list = epResp.episodes?.[audio];
      if (Array.isArray(list) && list.length > 0) {
        return { provider, episodes: list };
      }
      return null;
    }, signal);
  }

  // When total episode count is known, avoid settling on a fast partial list
  // (e.g. 2/10 episodes). Return immediately once a provider meets or exceeds
  // targetCount; otherwise finish probing and pick the highest-coverage list.
  const internal = new AbortController();
  const linked = signal ? AbortSignal.any([signal, internal.signal]) : internal.signal;
  let next = 0;
  let best: ProviderEpisodeProbe | null = null;
  const worker = async (): Promise<void> => {
    while (!linked.aborted) {
      const index = next++;
      if (index >= candidates.length) return;
      const provider = candidates[index];
      try {
        const epResp = await getEpisodes(mediaId, provider, linked);
        const list = epResp.episodes?.[audio];
        if (!Array.isArray(list) || list.length === 0) continue;
        if (!best || list.length > best.episodes.length) {
          best = { provider, episodes: list };
        }
        if (list.length >= targetCount) {
          internal.abort();
          return;
        }
      } catch {
        if (linked.aborted) return;
      }
    }
  };
  const count = Math.max(1, Math.min(PROBE_CONCURRENCY, candidates.length));
  await Promise.all(Array.from({ length: count }, () => worker()));
  if (signal?.aborted) return null;
  return best;
}
