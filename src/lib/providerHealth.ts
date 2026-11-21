import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./tauri";
import { optionHost, PROVIDERS, type PlayerOption, type Provider } from "./anivexa";

export interface ProviderHealthEntry {
  provider: string;
  server_host: string;
  success_count: number;
  failure_count: number;
  consecutive_failures: number;
  avg_ttff_ms: number | null;
  last_success_at: number | null;
  last_failure_at: number | null;
}

const STORAGE_KEY = "megu.providerHealth.v1";

function loadLocalHealth(): ProviderHealthEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is ProviderHealthEntry => !!item && typeof item.provider === "string" && typeof item.server_host === "string");
  } catch {
    return [];
  }
}

function saveLocalHealth(entries: ProviderHealthEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, 200)));
  } catch {
    // Ignore storage quota errors.
  }
}

export async function getProviderHealth(): Promise<ProviderHealthEntry[]> {
  if (isTauri) {
    try {
      return await invoke<ProviderHealthEntry[]>("get_provider_health");
    } catch {
      return loadLocalHealth();
    }
  }
  return loadLocalHealth();
}

export async function recordProviderOutcome(
  provider: Provider,
  urlOrHost: string,
  ok: boolean,
  ttffMs?: number,
): Promise<void> {
  const host = urlOrHost.includes("://") ? optionHost(urlOrHost) : urlOrHost.toLowerCase();
  const safeTtff = typeof ttffMs === "number" && Number.isFinite(ttffMs) ? Math.round(Math.max(0, Math.min(120_000, ttffMs))) : null;
  if (isTauri) {
    try {
      await invoke("record_provider_health", { provider, serverHost: host, ok, ttffMs: safeTtff });
      return;
    } catch {
      // Fall through to localStorage fallback.
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const entries = loadLocalHealth();
  const idx = entries.findIndex((e) => e.provider === provider && e.server_host === host);
  if (idx >= 0) {
    const prev = entries[idx];
    if (ok) {
      entries[idx] = {
        ...prev,
        success_count: prev.success_count + 1,
        consecutive_failures: 0,
        avg_ttff_ms: safeTtff === null ? prev.avg_ttff_ms : prev.avg_ttff_ms === null ? safeTtff : Math.round((prev.avg_ttff_ms * 3 + safeTtff) / 4),
        last_success_at: now,
      };
    } else {
      entries[idx] = {
        ...prev,
        failure_count: prev.failure_count + 1,
        consecutive_failures: prev.consecutive_failures + 1,
        last_failure_at: now,
      };
    }
  } else {
    entries.push({
      provider,
      server_host: host,
      success_count: ok ? 1 : 0,
      failure_count: ok ? 0 : 1,
      consecutive_failures: ok ? 0 : 1,
      avg_ttff_ms: ok ? safeTtff : null,
      last_success_at: ok ? now : null,
      last_failure_at: ok ? null : now,
    });
  }
  saveLocalHealth(entries);
}

/**
 * Compute a reliability score for a single health row.
 * Higher is better. Unknown rows start at 0; recent consecutive failures
 * temporarily demote a host, with decay after 20 minutes so recovered providers
 * are retried automatically.
 */
export function scoreHealthRow(row: ProviderHealthEntry | undefined, nowSecs = Math.floor(Date.now() / 1000)): number {
  if (!row) return 0;
  const total = row.success_count + row.failure_count;
  const rate = (row.success_count + 1) / (total + 2); // Laplace-smoothed success rate
  let score = (rate - 0.5) * 100;
  if (row.consecutive_failures > 0) {
    const ageSecs = row.last_failure_at ? Math.max(0, nowSecs - row.last_failure_at) : 0;
    const decay = ageSecs > 1200 ? 0.25 : 1;
    score -= Math.min(80, row.consecutive_failures * 22) * decay;
  }
  if (typeof row.avg_ttff_ms === "number" && row.avg_ttff_ms > 0) {
    score -= Math.min(15, row.avg_ttff_ms / 1000);
  }
  return score;
}

export function rankProviders(
  providers: readonly Provider[],
  health: ProviderHealthEntry[],
  preferred?: Provider | null,
  nowSecs = Math.floor(Date.now() / 1000),
): Provider[] {
  const byProvider = new Map<string, ProviderHealthEntry[]>();
  for (const row of health) {
    const list = byProvider.get(row.provider) ?? [];
    list.push(row);
    byProvider.set(row.provider, list);
  }
  const providerScore = (provider: Provider): number => {
    const rows = byProvider.get(provider);
    let score = 0;
    if (rows && rows.length > 0) {
      // Weight toward the provider's best-performing host, tempered by average.
      const scores = rows.map((r) => scoreHealthRow(r, nowSecs));
      const best = Math.max(...scores);
      const avg = scores.reduce((sum, v) => sum + v, 0) / scores.length;
      score = best * 0.7 + avg * 0.3;
    }
    if (preferred && provider === preferred) score += 12;
    return score;
  };
  const orderIndex = new Map(PROVIDERS.map((p, i) => [p, i]));
  return [...providers].sort((a, b) => {
    const diff = providerScore(b) - providerScore(a);
    if (Math.abs(diff) > 0.01) return diff;
    return (orderIndex.get(a) ?? 999) - (orderIndex.get(b) ?? 999);
  });
}

export function rankPlayerOptions(
  provider: Provider,
  options: PlayerOption[],
  health: ProviderHealthEntry[],
  nowSecs = Math.floor(Date.now() / 1000),
): PlayerOption[] {
  const index = new Map<string, ProviderHealthEntry>();
  for (const row of health) {
    if (row.provider === provider) index.set(row.server_host, row);
  }
  const baseOrder = new Map(options.map((opt, i) => [opt.url, i]));
  const optionScore = (option: PlayerOption): number => {
    const kindBonus = option.kind === "hls" ? 30 : option.kind === "mp4" ? 25 : option.url.includes("/videojs/") ? 8 : 0;
    const hostScore = scoreHealthRow(index.get(optionHost(option.url)), nowSecs);
    return kindBonus + hostScore;
  };
  return [...options].sort((a, b) => {
    const diff = optionScore(b) - optionScore(a);
    if (Math.abs(diff) > 0.01) return diff;
    return (baseOrder.get(a.url) ?? 0) - (baseOrder.get(b.url) ?? 0);
  });
}
