import { AnimatePresence, motion } from "framer-motion";
import { Check, List, X, Eye, CalendarClock, CircleCheck, CirclePause, CircleX, Repeat, Heart } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gql, LIST_STATUS_LABELS, saveListEntry, deleteListEntry, type ListStatus } from "../lib/anilist";
import { useAppStore, useAuthStore } from "../store/app";
import { syncNotice } from "../lib/autoSync";

type DateParts = { year: number | null; month: number | null; day: number | null };
type Entry = { id: number; status: ListStatus | null; progress: number | null; score: number | null; advancedScores: Record<string, number> | null; repeat: number | null; notes: string | null; private: boolean | null; hiddenFromStatusLists: boolean | null; customLists: string[] | null; startedAt: DateParts | null; completedAt: DateParts | null };
const emptyDate = (): DateParts => ({ year: null, month: null, day: null });
const validDate = (d: DateParts) => (d.year === null || (d.year >= 1 && d.year <= 9999)) && (d.month === null || (d.month >= 1 && d.month <= 12)) && (d.day === null || (d.day >= 1 && d.day <= (d.month ? new Date(Date.UTC(d.year || 2000, d.month, 0)).getUTCDate() : 31))) && [d.year, d.month, d.day].every((n) => n === null || Number.isInteger(n));
const statuses = Object.keys(LIST_STATUS_LABELS) as ListStatus[];
const icons = { CURRENT: Eye, PLANNING: CalendarClock, COMPLETED: CircleCheck, PAUSED: CirclePause, DROPPED: CircleX, REPEATING: Repeat };
const colors = { CURRENT: "text-emerald-300", PLANNING: "text-sky-300", COMPLETED: "text-violet-300", PAUSED: "text-amber-300", DROPPED: "text-rose-300", REPEATING: "text-cyan-300" };

export default function ListButton({ mediaId, entryId, title, cover, totalEpisodes }: { mediaId: number; entryId?: number; title?: string; cover?: string | null; totalEpisodes?: number | null }) {
  const token = useAuthStore((s) => s.token);
  const viewer = useAuthStore((s) => s.viewer);
  const setLoginOpen = useAppStore((s) => s.setLoginOpen);
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ListStatus>("CURRENT");
  const [progress, setProgress] = useState(0);
  const [score, setScore] = useState(0);
  const [repeat, setRepeat] = useState(0);
  const [notes, setNotes] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [customLists, setCustomLists] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState<DateParts>(emptyDate);
  const [completedAt, setCompletedAt] = useState<DateParts>(emptyDate);
  const [scoreChanged, setScoreChanged] = useState(false);
  const [advanced, setAdvanced] = useState<number[]>([]);
  const [advancedChanged, setAdvancedChanged] = useState(false);
  const [datesChanged, setDatesChanged] = useState({ started: false, completed: false });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["mediaListEntry", mediaId, viewer?.id],
    queryFn: async () => {
      const viewerData = await gql<{ Viewer: { mediaListOptions: { scoreFormat: string; animeList: { customLists: string[]; advancedScoring: string[] | null; advancedScoringEnabled: boolean } } } }>(
        `query { Viewer { mediaListOptions { scoreFormat animeList { customLists advancedScoring advancedScoringEnabled } } } }`, {}, token!,
      );
      const mediaData = await gql<{ Media: { isFavourite: boolean; mediaListEntry: Entry | null } }>(
        `query ($mediaId: Int!, $scoreFormat: ScoreFormat!) { Media(id: $mediaId, type: ANIME) { isFavourite mediaListEntry { id status progress score(format: $scoreFormat) advancedScores repeat notes private hiddenFromStatusLists customLists(asArray: true) startedAt { year month day } completedAt { year month day } } } }`,
        { mediaId, scoreFormat: viewerData.Viewer.mediaListOptions.scoreFormat }, token!,
      );
      return { ...viewerData, ...mediaData };
    },
    enabled: !!token && !!viewer,
    staleTime: 60_000,
  });
  const entry = data?.Media.mediaListEntry;
  const format = data?.Viewer.mediaListOptions.scoreFormat ?? "POINT_100";
  const scoreMax = format === "POINT_100" ? 100 : format === "POINT_5" ? 5 : format === "POINT_3" ? 3 : 10;
  const scoreStep = format === "POINT_10_DECIMAL" ? 0.1 : 1;
  const favourite = useMutation({
    mutationFn: () => gql(`mutation ($id: Int!) { ToggleFavourite(animeId: $id) { anime { pageInfo { total } } } }`, { id: mediaId }, token!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mediaListEntry", mediaId] }),
  });
  const mutation = useMutation({
    mutationFn: async (remove: boolean) => {
      if (!token) throw new Error("Sign in to AniList first.");
      if (remove) {
        const id = entry?.id ?? entryId;
        if (!id) throw new Error("List entry not found.");
        await deleteListEntry(token, id);
      } else {
        if (!Number.isSafeInteger(progress) || progress < 0 || (totalEpisodes && progress > totalEpisodes) || !Number.isFinite(score) || score < 0 || score > scoreMax || Math.abs(score / scoreStep - Math.round(score / scoreStep)) > 0.00001 || advanced.some((n) => !Number.isFinite(n) || n < 0 || n > 100) || !Number.isSafeInteger(repeat) || repeat < 0 || !validDate(startedAt) || !validDate(completedAt)) throw new Error("Enter valid counts, score, and date components.");
        await saveListEntry(token, mediaId, {
          status, progress, ...(scoreChanged ? { scoreFormatted: score } : {}),
          ...(advancedChanged ? { advancedScores: advanced } : {}),
          ...(repeat !== (entry?.repeat ?? 0) ? { repeat } : {}),
          ...(notes !== (entry?.notes ?? "") ? { notes } : {}),
          ...(isPrivate !== (entry?.private ?? false) ? { private: isPrivate } : {}),
          ...(hidden !== (entry?.hiddenFromStatusLists ?? false) ? { hiddenFromStatusLists: hidden } : {}),
          ...(JSON.stringify(customLists) !== JSON.stringify(entry?.customLists ?? []) ? { customLists } : {}),
          ...(datesChanged.started ? { startedAt } : {}),
          ...(datesChanged.completed ? { completedAt } : {}),
        });
      }
    },
    onSuccess: async (_, remove) => {
      setOpen(false);
      const changes = [LIST_STATUS_LABELS[status], `episode ${progress}`, `score ${score}/${scoreMax}`];
      if (repeat !== (entry?.repeat ?? 0)) changes.push(`${repeat} rewatch${repeat === 1 ? "" : "es"}`);
      if (notes !== (entry?.notes ?? "")) changes.push("notes updated");
      if (isPrivate !== (entry?.private ?? false)) changes.push(isPrivate ? "set private" : "set public");
      syncNotice(remove ? `${title ?? "Anime"} removed from AniList.` : `${title ? `${title}: ` : ""}AniList updated · ${changes.join(" · ")}.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mediaListEntry", mediaId] }),
        queryClient.invalidateQueries({ queryKey: ["userList"] }),
      ]);
    },
  });
  const busyRef = useRef(false);
  useEffect(() => { busyRef.current = mutation.isPending; }, [mutation.isPending]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); setOpen(false); return; }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, [open]);

  const edit = () => {
    if (!token) { setLoginOpen(true); return; }
    setStatus(entry?.status ?? "CURRENT");
    setProgress(entry?.progress ?? 0);
    setScore(entry?.score ?? 0);
    setScoreChanged(false);
    setAdvanced((data?.Viewer.mediaListOptions.animeList.advancedScoring ?? []).map((name) => entry?.advancedScores?.[name] ?? 0));
    setAdvancedChanged(false);
    setRepeat(entry?.repeat ?? 0);
    setNotes(entry?.notes ?? "");
    setPrivate(entry?.private ?? false);
    setHidden(entry?.hiddenFromStatusLists ?? false);
    setCustomLists(entry?.customLists ?? []);
    setStartedAt(entry?.startedAt ?? emptyDate());
    setCompletedAt(entry?.completedAt ?? emptyDate());
    setDatesChanged({ started: false, completed: false });
    mutation.reset();
    setConfirmDelete(false);
    setOpen(true);
  };

  return <>
    <button onClick={edit} disabled={!!token && isLoading} className="flex items-center gap-2 rounded-md bg-zinc-700/80 px-5 py-2.5 font-semibold text-white backdrop-blur transition hover:bg-zinc-600 disabled:opacity-50">
      {entry?.status ? <Check className="size-5" /> : <List className="size-5" />}
      {entry?.status ? LIST_STATUS_LABELS[entry.status] : "My List"}
    </button>
    {createPortal(<AnimatePresence>
      {open && <motion.div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/75 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !mutation.isPending && setOpen(false)}>
        <motion.section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="list-editor-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-900 p-6 text-zinc-100 shadow-2xl outline-none" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }} onClick={(e) => e.stopPropagation()}>
          <div className="flex items-start justify-between gap-4"><div className="flex min-w-0 items-center gap-3">{cover && <img src={cover} alt="" className="h-20 w-14 rounded-md object-cover" />}<div className="min-w-0"><h2 id="list-editor-title" className="text-xl font-bold">Edit AniList entry</h2>{title && <p className="mt-1 break-words text-sm font-medium text-zinc-200">{title}</p>}<p className="mt-1 text-sm text-zinc-400">Changes are saved to your AniList account.</p></div></div><button aria-label="Close editor" onClick={() => setOpen(false)} disabled={mutation.isPending} className="rounded-lg p-1 hover:bg-zinc-700"><X className="size-5" /></button></div>
          {error ? <div className="mt-5 text-sm text-red-300">Could not load your AniList entry. <button className="underline" onClick={() => void refetch()}>Retry</button></div> : <>
            <h3 className="mt-6 text-sm font-semibold text-zinc-300">Status</h3>
            <button disabled={favourite.isPending} aria-pressed={!!data?.Media.isFavourite} onClick={() => favourite.mutate()} className="mt-3 flex items-center gap-2 text-sm text-zinc-300 disabled:opacity-50"><Heart className={`size-4 ${data?.Media.isFavourite ? "fill-red-500 text-red-500" : ""}`} /> {data?.Media.isFavourite ? "Remove from favourites" : "Add to favourites"}</button>
            {favourite.error && <p role="alert" className="mt-2 text-sm text-red-300">{favourite.error.message}</p>}
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">{statuses.map((s) => { const Icon = icons[s]; return <button key={s} onClick={() => setStatus(s)} aria-pressed={status === s} className={`rounded-lg border px-3 py-2 text-left text-sm transition ${status === s ? "border-red-400 bg-red-500/20 text-white" : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}><Icon className={`mr-1 inline size-4 ${colors[s]}`} />{LIST_STATUS_LABELS[s]}</button>; })}</div>
            <div className="mt-5 grid grid-cols-2 gap-4"><label className="text-sm text-zinc-300">Episodes watched {totalEpisodes ? <span className="text-zinc-500">/ {totalEpisodes}</span> : null}<input type="number" min="0" max={totalEpisodes ?? undefined} step="1" value={progress} onChange={(e) => setProgress(e.currentTarget.valueAsNumber)} className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-white" /></label><label className="text-sm text-zinc-300">Score <span className="text-zinc-500">/ {scoreMax} · {format.replaceAll("_", " ")}</span><input type="number" min="0" max={scoreMax} step={scoreStep} value={score} onChange={(e) => { setScore(e.currentTarget.valueAsNumber); setScoreChanged(true); }} className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-white" /></label></div>
            {data?.Viewer.mediaListOptions.animeList.advancedScoringEnabled && <fieldset className="mt-5"><legend className="text-sm text-zinc-300">Advanced scores <span className="text-zinc-500">/ 100</span></legend><div className="mt-2 grid grid-cols-2 gap-3">{data.Viewer.mediaListOptions.animeList.advancedScoring?.map((name, index) => <label key={name} className="text-sm text-zinc-400">{name}<input type="number" min="0" max="100" step="0.1" value={advanced[index] ?? 0} onChange={(e) => { const value = e.currentTarget.valueAsNumber; setAdvanced((old) => old.map((n, i) => i === index ? value : n)); setAdvancedChanged(true); }} className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-white" /></label>)}</div></fieldset>}
            <div className="mt-5 grid gap-4">{([ ["Start date", startedAt, setStartedAt, "started"], ["Finish date", completedAt, setCompletedAt, "completed"] ] as const).map(([label, value, setter, key]) => <fieldset key={key}><legend className="text-sm text-zinc-300">{label} <span className="text-zinc-500">(each part optional)</span></legend><div className="mt-2 grid grid-cols-3 gap-2">{([ ["year", 9999], ["month", 12], ["day", 31] ] as const).map(([part, max]) => <input key={part} aria-label={`${label} ${part}`} type="number" min="1" max={max} placeholder={part[0].toUpperCase() + part.slice(1)} value={value[part] ?? ""} onChange={(e) => { const next = e.currentTarget.value === "" ? null : e.currentTarget.valueAsNumber; setter((old) => ({ ...old, [part]: next })); setDatesChanged((old) => ({ ...old, [key]: true })); }} className="min-w-0 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-white" />)}</div></fieldset>)}</div>
            <div className="mt-5 space-y-2"><label className="flex gap-2 text-sm"><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.currentTarget.checked)} /> Hide from status lists</label>{data?.Viewer.mediaListOptions.animeList.customLists?.map((list) => <label key={list} className="flex gap-2 text-sm"><input type="checkbox" checked={customLists.includes(list)} onChange={(e) => { const checked = e.currentTarget.checked; setCustomLists((old) => checked ? [...old, list] : old.filter((name) => name !== list)); }} /> {list}</label>)}</div>
            <details className="mt-5 rounded-lg border border-zinc-700 bg-zinc-800/50 p-3"><summary className="cursor-pointer text-sm font-semibold text-zinc-200">More AniList details</summary><div className="mt-4 space-y-4"><label className="block text-sm text-zinc-300">Times rewatched<input type="number" min="0" step="1" value={repeat} onChange={(e) => setRepeat(e.currentTarget.valueAsNumber)} className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-white" /></label><label className="block text-sm text-zinc-300">Notes<textarea value={notes} onChange={(e) => setNotes(e.currentTarget.value)} rows={3} className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-white" /></label><label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.currentTarget.checked)} className="accent-red-500" /> Private AniList entry</label></div></details>
            {mutation.error && <p role="alert" className="mt-4 text-sm text-red-300">{mutation.error.message}</p>}
            {confirmDelete && <div className="mt-5 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm"><p>Remove this anime from your AniList list?</p><div className="mt-3 flex gap-3"><button disabled={mutation.isPending} onClick={() => setConfirmDelete(false)} className="rounded bg-zinc-700 px-3 py-2 hover:bg-zinc-600">Cancel</button><button disabled={mutation.isPending} onClick={() => mutation.mutate(true)} className="rounded bg-red-700 px-3 py-2 hover:bg-red-600">Remove entry</button></div></div>}
            <div className="mt-6 flex flex-wrap justify-between gap-3">{entry && !confirmDelete && <button disabled={mutation.isPending} onClick={() => setConfirmDelete(true)} className="text-sm text-red-300 hover:text-red-200 disabled:opacity-50">Remove from list</button>}<button disabled={mutation.isPending} onClick={() => mutation.mutate(false)} className="ml-auto rounded-lg bg-red-600 px-5 py-2.5 font-semibold text-white hover:bg-red-500 disabled:opacity-50">{mutation.isPending ? "Saving…" : "Save to AniList"}</button></div>
          </>}
        </motion.section>
      </motion.div>}
    </AnimatePresence>, document.body)}
  </>;
}
