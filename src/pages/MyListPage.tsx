import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { LogOut, RefreshCw, User as UserIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  LIST_STATUS_LABELS,
  getUserList,
  saveListEntry,
  type ListStatus,
} from "../lib/anilist";
import {
  clearPendingProgress,
  getListSnapshot,
  getPendingProgress,
  isTauri,
  logout as tauriLogout,
  queueProgress,
  saveListSnapshot,
  type PendingProgress,
} from "../lib/tauri";
import { displayTitle } from "../lib/anilist";
import { useAppStore, useAuthStore } from "../store/app";
import { syncNotice } from "../lib/autoSync";
import ContinuePlayback from "../components/ContinuePlayback";
import CachedImage from "../components/CachedImage";
import { cacheListArtwork } from "../lib/artwork";

type Tab = "ALL" | ListStatus;

const TABS: Tab[] = ["ALL", "CURRENT", "PLANNING", "COMPLETED", "PAUSED", "DROPPED"];
const MAX_PER_PAGE = 60;

export default function MyListPage({ continuing = false }: { continuing?: boolean }) {
  const token = useAuthStore((s) => s.token);
  const viewer = useAuthStore((s) => s.viewer);
  const clearSession = useAuthStore((s) => s.clearSession);
  const setLoginOpen = useAppStore((s) => s.setLoginOpen);
  const openDetail = useAppStore((s) => s.openDetail);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("CURRENT");
  const [visible, setVisible] = useState(MAX_PER_PAGE);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const { data: remote, isLoading: remoteLoading, error: remoteError } = useQuery({
    queryKey: ["userList", viewer?.id],
    queryFn: async () => {
      const entries = await getUserList(token!);
      void cacheListArtwork(entries.map((entry) => entry.media.coverImage?.extraLarge || entry.media.coverImage?.large));
      if (isTauri && viewer) {
        try {
          await saveListSnapshot(viewer.id, entries);
          setCacheError(null);
          await queryClient.invalidateQueries({ queryKey: ["listSnapshot", viewer.id] });
        } catch (e) { setCacheError(`Your online list loaded, but could not be saved offline: ${String(e)}`); }
      }
      return entries;
    },
    enabled: !!token && !!viewer,
    staleTime: 120_000,
  });

  const { data: local, error: localError } = useQuery({
    queryKey: ["listSnapshot", viewer?.id],
    queryFn: () => getListSnapshot(viewer!.id),
    enabled: isTauri && !!token && !!viewer,
  });
  const { data: pending = [], error: pendingError } = useQuery({
    queryKey: ["pendingProgress", viewer?.id],
    queryFn: () => getPendingProgress(viewer!.id),
    enabled: isTauri && !!token && !!viewer,
  });

  const doSync = async () => {
    if (!token || !viewer) return;
    setSyncing(true);
    setSyncError(null);
    try {
      const entries = await getUserList(token);
      const conflicts: string[] = [];
      for (const change of pending) {
        const remoteEntry = entries.find((entry) => entry.media.id === change.media_id);
        if (!remoteEntry || (remoteEntry.progress ?? 0) !== change.base_progress || remoteEntry.status !== change.base_status) {
          // A previous save may have succeeded even if its response was lost.
          if (remoteEntry && remoteEntry.progress === change.progress && remoteEntry.status === change.base_status) {
            if (isTauri) await saveListSnapshot(viewer.id, entries);
            await clearPendingProgress(viewer.id, change);
          } else conflicts.push(remoteEntry ? displayTitle(remoteEntry.media.title) : `ID ${change.media_id}`);
          continue;
        }
        const updated = await saveListEntry(token, change.media_id, { progress: change.progress });
        Object.assign(remoteEntry, updated);
        if (isTauri) await saveListSnapshot(viewer.id, entries);
        await clearPendingProgress(viewer.id, change);
      }
      if (isTauri) await saveListSnapshot(viewer.id, entries);
      setCacheError(null);
      queryClient.setQueryData(["userList", viewer.id], entries);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["listSnapshot", viewer.id] }), queryClient.invalidateQueries({ queryKey: ["pendingProgress", viewer.id] })]);
      if (conflicts.length) setSyncError(`Not synced because AniList changed: ${conflicts.join(", ")}. Review and discard the local edit before trying again.`);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
      await queryClient.invalidateQueries({ queryKey: ["pendingProgress", viewer.id] });
    } finally {
      setSyncing(false);
    }
  };

  const onLogout = async () => {
    if (isTauri) await tauriLogout().catch(() => {});
    clearSession();
    queryClient.removeQueries({ queryKey: ["userList"] });
    queryClient.removeQueries({ queryKey: ["mediaListEntry"] });
  };

  // ─── Not signed in ────────────────────────────────────────────────────────
  if (!token) {
    return (
      <main className="mx-auto max-w-[1600px] px-4 pt-24 sm:px-8 pb-16">
        <motion.h1 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-6 text-2xl font-bold">
          {continuing ? "Continue Watching" : "My List"}
        </motion.h1>
        {continuing && <ContinuePlayback />}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="flex flex-col items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900/50 px-6 py-24 text-center"
        >
          <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-zinc-800">
            <UserIcon className="size-7 text-zinc-400" />
          </div>
          <h2 className="text-lg font-semibold">Sign in with AniList to sync your list</h2>
          <p className="mt-2 max-w-md text-sm text-zinc-500">
            Connect your account to see your watch progress, continue watching, and sync
            changes across devices.
          </p>
          <button
            onClick={() => setLoginOpen(true)}
            className="mt-6 rounded-md bg-[--color-accent] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[--color-accent-dim]"
          >
            Connect AniList
          </button>
          <button onClick={() => setReviewOpen(!reviewOpen)} className="rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700">Sync review ({pending.length})</button>
        </motion.div>
      </main>
    );
  }

  const source = remote ?? local ?? [];
  const entries = source.map((entry) => {
    const change = pending.find((p) => p.media_id === entry.media.id);
    return change ? { ...entry, progress: change.progress } : entry;
  });
  const activeTab = continuing ? "CURRENT" : tab;
  const filtered = activeTab === "ALL" ? entries : entries.filter((e) => e.status === activeTab);

  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.status ?? "CURRENT"] = (counts[e.status ?? "CURRENT"] ?? 0) + 1;

  return (
    <main className="mx-auto max-w-[1600px] px-4 pt-24 sm:px-8 pb-16">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        {viewer?.avatar?.large && (
          <img src={viewer.avatar.large} alt={viewer.name} className="size-12 rounded-full object-cover" />
        )}
        <div>
          <h1 className="text-2xl font-bold">{continuing ? "Continue Watching" : viewer?.name ?? "My List"}</h1>
          <p className="text-sm text-zinc-500">{remote ? `${entries.length} titles on AniList` : local ? `${entries.length} cached titles` : "No cached list yet"}{pending.length > 0 ? ` · ${pending.length} pending progress ${pending.length === 1 ? "change" : "changes"}` : ""}</p>
        </div>
        <div className="ml-auto flex gap-2">
          <button
            onClick={doSync}
            disabled={syncing || !!pendingError}
            className="flex items-center gap-2 rounded-md bg-zinc-800 px-4 py-2 text-sm font-medium hover:bg-zinc-700 disabled:opacity-50"
          >
            <RefreshCw className={`size-4 ${syncing ? "animate-spin" : ""}`} /> {pending.length ? "Sync pending changes" : "Sync"}
          </button>
          <button
            onClick={onLogout}
            className="flex items-center gap-2 rounded-md bg-zinc-800 px-4 py-2 text-sm font-medium text-red-300 hover:bg-zinc-700"
          >
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      </div>

      {(syncError || cacheError || localError || pendingError || remoteError) && (
        <p className="mb-4 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-sm text-red-300">
          {syncError ?? cacheError ?? (localError ? `Local cache: ${String(localError)}` : null) ?? (pendingError ? `Pending changes: ${String(pendingError)}` : null) ?? (local ? "AniList unavailable. Showing your saved list; local progress edits will retry automatically." : remoteError?.message)}
        </p>
      )}
      {reviewOpen && <section className="mb-6 rounded-xl border border-zinc-700 bg-zinc-900 p-5"><h2 className="text-lg font-semibold">Sync review</h2><p className="mt-1 text-sm text-zinc-400">Compare queued edits with AniList before choosing which progress to keep. Refresh your list with Sync for the latest remote values.</p>{pending.length === 0 ? <p className="mt-4 text-sm text-zinc-400">No pending progress edits.</p> : <div className="mt-4 space-y-3">{pending.map((change) => { const current = remote?.find((e) => e.media.id === change.media_id); const conflict = current && ((current.progress ?? 0) !== change.base_progress || current.status !== change.base_status); return <div key={change.media_id} className="rounded-lg border border-zinc-700 p-3"><p className="font-semibold">{current ? displayTitle(current.media.title) : `Title ${change.media_id}`}</p><p className="mt-1 text-sm text-zinc-400">Original: episode {change.base_progress} ({change.base_status}) · Local: episode {change.progress} · AniList: {current ? `episode ${current.progress ?? 0} (${current.status})` : "not loaded or removed"}{conflict ? " · Conflict" : ""}</p><div className="mt-3 flex flex-wrap gap-3"><button disabled={syncing} onClick={() => { if (!window.confirm("Discard this local progress edit and keep AniList's version?")) return; setSyncing(true); void clearPendingProgress(viewer!.id, change).then(() => queryClient.invalidateQueries({ queryKey: ["pendingProgress", viewer!.id] })).catch((e: unknown) => setSyncError(String(e))).finally(() => setSyncing(false)); }} className="rounded bg-zinc-700 px-3 py-2 text-sm disabled:opacity-50">Discard local edit</button><button disabled={syncing || !current} onClick={() => { if (!window.confirm(`Overwrite AniList progress with episode ${change.progress}?`)) return; setSyncing(true); void (async () => { const latest = await getUserList(token); const item = latest.find((e) => e.media.id === change.media_id); if (!item || item.progress !== current?.progress || item.status !== current.status) throw new Error("AniList changed since review. Sync and review again."); const updated = await saveListEntry(token, change.media_id, { progress: change.progress }); Object.assign(item, updated); await saveListSnapshot(viewer!.id, latest); await clearPendingProgress(viewer!.id, change); queryClient.setQueryData(["userList", viewer!.id], latest); await Promise.all([queryClient.invalidateQueries({ queryKey: ["pendingProgress", viewer!.id] }), queryClient.invalidateQueries({ queryKey: ["listSnapshot", viewer!.id] })]); })().catch((e: unknown) => setSyncError(String(e))).finally(() => setSyncing(false)); }} className="rounded bg-red-700 px-3 py-2 text-sm disabled:opacity-50">Keep local progress</button></div></div>; })}</div>}</section>}

      {/* Tabs */}
      {!continuing && <div className="no-scrollbar mb-6 flex gap-2 overflow-x-auto">
        {TABS.map((t) => {
          const active = tab === t;
          const count = t === "ALL" ? entries.length : counts[t] ?? 0;
          return (
            <button
              key={t}
              onClick={() => { setTab(t); setVisible(MAX_PER_PAGE); }}
              className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition ${
                active ? "bg-white text-black" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              {t === "ALL" ? "All" : LIST_STATUS_LABELS[t]} <span className="opacity-60 text-xs">{count}</span>
            </button>
          );
        })}
      </div>}

      {continuing && <><ContinuePlayback /><h2 className="mb-2 text-lg font-semibold">Watching on AniList</h2><p className="mb-6 text-sm text-zinc-400">Your AniList watching list is shown separately from playback saved on this device.</p></>}

      {remoteLoading && !remote && !local ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
          {Array.from({ length: 16 }).map((_, i) => (
            <div key={i} className="animate-pulse rounded-lg bg-zinc-800 aspect-[3/4]" />
          ))}
        </div>
      ) : !remote && !local && (remoteError || localError) ? (
        <p className="py-16 text-center text-zinc-500">Your list could not be loaded, and no account-specific offline snapshot is available yet. Check your connection and press Sync to retry.</p>
      ) : filtered.length === 0 ? (
        <p className="py-16 text-center text-zinc-500">
          No titles here yet.{" "}
          {activeTab === "CURRENT" && "Add something to your Watching list and it will show up here."}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {filtered.slice(0, visible).map((entry, i) => (
              <ListCard key={entry.id} entry={entry} original={source.find((e) => e.media.id === entry.media.id)!} pending={pending.find((p) => p.media_id === entry.media.id)} userId={viewer!.id} index={i} onOpen={openDetail} allowEdits={!pendingError && !syncing} />
            ))}
          </div>
          {visible < filtered.length && (
            <div className="mt-8 text-center">
              <button
                onClick={() => setVisible((v) => v + MAX_PER_PAGE)}
                className="rounded-md bg-zinc-800 px-6 py-2.5 text-sm font-medium hover:bg-zinc-700"
              >
                Show more ({filtered.length - visible} remaining)
              </button>
            </div>
          )}
        </>
      )}

    </main>
  );
}

// ─── Card with inline status / progress editing ─────────────────────────────

import type { MediaListEntry } from "../lib/anilist";

function ListCard({ entry, original, pending, userId, index, onOpen, allowEdits }: { entry: MediaListEntry; original: MediaListEntry; pending?: PendingProgress; userId: number; index: number; onOpen: (id: number) => void; allowEdits: boolean }) {
  const token = useAuthStore((s) => s.token)!;
  const queryClient = useQueryClient();
  const m = entry.media;
  const title = displayTitle(m.title);
  const cover = m.coverImage?.extraLarge || m.coverImage?.large;
  const total = m.episodes ?? 0;
  const progress = entry.progress ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((progress / total) * 100)) : 0;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(progress);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const applyProgress = async (value: number) => {
    if (!allowEdits) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (isTauri) {
        if (!original.status) throw new Error("This entry has no AniList status; sync your list first.");
        await queueProgress(userId, m.id, original.progress ?? 0, original.status, value);
        await queryClient.invalidateQueries({ queryKey: ["pendingProgress", userId] });
        window.dispatchEvent(new Event("megu-manualsync-queued"));
      } else {
        await saveListEntry(token, m.id, { progress: value });
        syncNotice(`${title}: AniList updated to episode ${value}.`);
        await queryClient.invalidateQueries({ queryKey: ["userList", userId] });
      }
      setEditing(false);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.3) }}
      className="group relative overflow-hidden rounded-lg bg-[--color-card] shadow-md"
    >
      <button onClick={() => onOpen(m.id)} className="block w-full text-left outline-none">
        <div className="aspect-[3/4] w-full overflow-hidden bg-zinc-800">
          {cover ? (
            <CachedImage src={cover} alt={title} loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-110" />
          ) : (
            <div className="flex size-full items-center justify-center text-2xl font-bold text-zinc-600">{title.slice(0, 1)}</div>
          )}
        </div>
        <div className="p-2">
          <p className="truncate text-xs font-semibold">{title}</p>
          <p className="mt-0.5 text-[11px] text-zinc-400">
            Ep {progress}{total > 0 ? `/${total}` : ""} · {entry.status ? LIST_STATUS_LABELS[entry.status] : ""}
          </p>
          {m.nextAiringEpisode && <AiringCountdown airing={m.nextAiringEpisode} />}
          {pending && <p className="mt-1 text-[11px] text-amber-300">Saved locally · pending sync</p>}
          {saveError && <p role="alert" className="mt-1 text-[11px] text-red-300">{saveError}</p>}
          {pct > 0 && (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-700">
              <div className="h-full rounded-full bg-[--color-accent]" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </button>
      {pending && <button disabled={saving || !allowEdits} onClick={() => { setSaving(true); void clearPendingProgress(userId, pending).then(() => queryClient.invalidateQueries({ queryKey: ["pendingProgress", userId] })).catch((e: unknown) => setSaveError(String(e))).finally(() => setSaving(false)); }} className="px-2 pb-2 text-xs text-zinc-400 underline disabled:opacity-40">Discard local edit</button>}

      {/* Hover edit */}
      <div className="absolute inset-x-0 top-0 flex justify-end p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        {editing ? (
          <div className="flex items-center gap-1 rounded-md bg-black/80 p-1 backdrop-blur">
            <button onClick={() => applyProgress(Math.max(0, draft - 1))} disabled={saving} className="rounded bg-zinc-700 px-2 py-1 text-xs">−</button>
            <input
              type="number"
              value={draft}
              min={0}
              max={total || undefined}
              onChange={(e) => setDraft(Math.max(0, parseInt(e.target.value) || 0))}
              className="w-12 rounded bg-zinc-800 px-1 py-1 text-center text-xs outline-none"
            />
            <button onClick={() => applyProgress(Math.min(total || draft + 1, draft + 1))} disabled={saving} className="rounded bg-zinc-700 px-2 py-1 text-xs">+</button>
            <button onClick={() => applyProgress(draft)} disabled={saving} className="rounded bg-[--color-accent] px-2 py-1 text-xs font-semibold">Save</button>
          </div>
        ) : (
          <button
            onClick={() => { setDraft(progress); setEditing(true); }}
            disabled={!allowEdits}
            className="rounded-md bg-black/80 px-2 py-1 text-[11px] font-medium backdrop-blur hover:bg-black disabled:opacity-40"
          >
            Edit ep
          </button>
        )}
      </div>
    </motion.div>
  );
}

function AiringCountdown({ airing }: { airing: { episode: number; airingAt: number } }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  const minutes = Math.max(0, Math.ceil((airing.airingAt * 1000 - now) / 60_000));
  if (!minutes) return <p className="mt-1 text-[11px] text-amber-300">Episode {airing.episode} airing now</p>;
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  return <p className="mt-1 text-[11px] text-amber-300" title="Broadcast time; streaming availability is not guaranteed">Episode {airing.episode} in {days ? `${days}d ` : ""}{hours ? `${hours}h ` : ""}{mins}m</p>;
}
