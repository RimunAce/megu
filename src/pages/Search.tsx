import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Search as SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "../components/Card";
import { searchMedia } from "../lib/anilist";
import { useAppStore } from "../store/app";

export default function SearchPage() {
  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const [debounced, setDebounced] = useState(query);
  const [genre, setGenre] = useState("");
  const [season, setSeason] = useState("");
  const [year, setYear] = useState("");
  const [format, setFormat] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 400);
    return () => clearTimeout(t);
  }, [query]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["search", debounced, genre, season, year, format, page],
    queryFn: () => searchMedia(debounced, page, 48, { ...(genre && { genre }), ...(season && { season }), ...(year && { seasonYear: Number(year) }), ...(format && { format }) }),
    enabled: !debounced.trim() || debounced.trim().length > 1,
  });

  const items = data?.media ?? [];

  return (
    <main className="mx-auto max-w-[1600px] px-4 pt-24 sm:px-8 pb-16">
      <h1 className="mb-4 text-2xl font-bold">Search</h1>

      <div className="mb-6 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 max-w-xl">
        <SearchIcon className="size-5 text-zinc-400" />
        <input
          autoFocus
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(1); }}
          placeholder="Search anime titles..."
          className="w-full bg-transparent text-base outline-none placeholder:text-zinc-500"
        />
      </div>

      <div className="mb-6 flex flex-wrap gap-3" aria-label="Discovery filters">
        <select aria-label="Genre" value={genre} onChange={(e) => { setGenre(e.target.value); setPage(1); }} className="rounded-lg bg-zinc-800 p-2"><option value="">All genres</option>{["Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"].map((v) => <option key={v}>{v}</option>)}</select>
        <select aria-label="Season" value={season} onChange={(e) => { setSeason(e.target.value); setPage(1); }} className="rounded-lg bg-zinc-800 p-2"><option value="">All seasons</option>{["WINTER", "SPRING", "SUMMER", "FALL"].map((v) => <option key={v} value={v}>{v}</option>)}</select>
        <input aria-label="Year" type="number" min="1900" max="2100" placeholder="Year" value={year} onChange={(e) => { setYear(e.target.value); setPage(1); }} className="w-24 rounded-lg bg-zinc-800 p-2" />
        <select aria-label="Format" value={format} onChange={(e) => { setFormat(e.target.value); setPage(1); }} className="rounded-lg bg-zinc-800 p-2"><option value="">All formats</option>{["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"].map((v) => <option key={v} value={v}>{v.replace("_", " ")}</option>)}</select>
      </div>

      {isLoading && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
          {Array.from({ length: 16 }).map((_, i) => (
            <div key={i} className="animate-pulse rounded-lg bg-zinc-800 aspect-[3/4]" />
          ))}
        </div>
      )}

      {error && <p className="text-red-400 text-sm">{error.message}</p>}

      {!isLoading && items.length > 0 && (
        <>
          <p className="mb-3 text-sm text-zinc-400">
            {debounced ? `${data?.pageInfo.total ?? items.length} results for “${debounced}”` : "Popular anime"} · Page {page}
          </p>
          <motion.div
            layout
            className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8"
          >
            {items.map((m, i) => (
              <Card key={m.id} media={m} index={i} />
            ))}
          </motion.div>
          <div className="mt-6 flex gap-3"><button disabled={page === 1} onClick={() => setPage(page - 1)} className="rounded bg-zinc-800 px-4 py-2 disabled:opacity-40">Previous</button><button disabled={!data?.pageInfo.hasNextPage} onClick={() => setPage(page + 1)} className="rounded bg-zinc-800 px-4 py-2 disabled:opacity-40">Next</button></div>
        </>
      )}

      {!isLoading && (!debounced.trim() || debounced.trim().length > 1) && items.length === 0 && !error && (
        <p className="text-zinc-500">No results found. Try a different title.</p>
      )}
    </main>
  );
}
