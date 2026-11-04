import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowLeft, Calendar, Clock, Play, Star, Tv } from "lucide-react";
import { useState } from "react";
import { displayTitle, getMedia } from "../lib/anilist";
import { openStreamUrl } from "../lib/tauri";
import { useAppStore } from "../store/app";
import ListButton from "../components/ListButton";
import AnimePahe from "../components/AnimePahe";
import Anivexa from "../components/Anivexa";
import CachedImage from "../components/CachedImage";

export default function DetailPage({ id }: { id: number }) {
  const [streamError, setStreamError] = useState<string | null>(null);
  const closeDetail = useAppStore((s) => s.closeDetail);
  const { data: media, isLoading, error } = useQuery({
    queryKey: ["media", id],
    queryFn: () => getMedia(id),
  });

  if (isLoading) {
    return (
      <div className="pt-24 mx-auto max-w-[1200px] px-4">
        <div className="h-[420px] animate-pulse rounded-xl bg-zinc-800" />
        <div className="mt-8 h-8 w-2/3 animate-pulse rounded bg-zinc-800" />
        <div className="mt-4 h-4 w-full animate-pulse rounded bg-zinc-800" />
        <div className="mt-2 h-4 w-5/6 animate-pulse rounded bg-zinc-800" />
      </div>
    );
  }

  if (error || !media) {
    return (
      <div className="pt-32 text-center">
        <p className="text-red-400">{error?.message ?? "Anime not found"}</p>
        <button onClick={closeDetail} className="mt-4 rounded bg-zinc-800 px-4 py-2 hover:bg-zinc-700">
          Back
        </button>
      </div>
    );
  }

  const title = displayTitle(media.title);
  const banner = media.bannerImage || media.coverImage?.extraLarge;

  return (
    <motion.main
      className="pb-16"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Backdrop */}
      <div className="relative flex min-h-[max(380px,55vh)] w-full flex-col justify-end overflow-hidden">
        {banner && <CachedImage src={banner} alt="" className="absolute inset-0 size-full object-cover object-top" />}
        <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/30 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-[--color-base] via-transparent to-transparent" />
        <button
          onClick={closeDetail}
          className="absolute left-4 top-20 z-10 flex size-10 items-center justify-center rounded-full bg-black/60 hover:bg-black/80 transition"
          aria-label="Go back"
        >
          <ArrowLeft className="size-5" />
        </button>

        <div className="relative mx-auto w-full max-w-[1600px] px-4 pb-10 pt-32 sm:px-8">
          <h1 className="max-w-3xl break-words text-3xl font-black drop-shadow-xl sm:text-5xl">{title}</h1>
          <div className="mt-5 flex flex-wrap gap-3">
            <button onClick={() => document.getElementById("episodes")?.scrollIntoView({ behavior: "smooth" })} className="flex items-center gap-2 rounded-md bg-white px-6 py-2.5 font-semibold text-black transition hover:bg-white/80">
              <Play className="size-5 fill-black" /> Where to watch
            </button>
            <ListButton mediaId={id} title={title} cover={media.coverImage?.large} totalEpisodes={media.episodes} />
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="mx-auto grid max-w-[1600px] min-w-0 gap-10 px-4 pt-8 sm:px-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 break-words">
          <div className="flex flex-wrap items-center gap-4 text-sm text-zinc-300">
            {media.averageScore && (
              <span className="flex items-center gap-1 text-green-400 font-semibold">
                <Star className="size-4 fill-green-400" /> {(media.averageScore / 10).toFixed(1)}
              </span>
            )}
            {media.seasonYear && (
              <span className="flex items-center gap-1.5">
                <Calendar className="size-4" /> {media.seasonYear}
              </span>
            )}
            {media.format && (
              <span className="flex items-center gap-1.5 rounded border border-zinc-600 px-1.5 py-0.5 text-xs">
                <Tv className="size-3.5" /> {media.format}
              </span>
            )}
            {media.episodes && <span>{media.episodes} Episodes</span>}
            {media.duration && (
              <span className="flex items-center gap-1.5">
                <Clock className="size-4" /> {media.duration} min
              </span>
            )}
            {media.status && <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{media.status.replace(/_/g, " ")}</span>}
          </div>

          {media.genres && (
            <div className="mt-4 flex flex-wrap gap-2">
              {media.genres.map((g) => (
                <span key={g} className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-300">{g}</span>
              ))}
            </div>
          )}

          {media.description && (
            <p className="mt-6 max-w-3xl leading-relaxed text-zinc-300">
              {media.description.replace(/<[^>]*>/g, "")}
            </p>
          )}

          <section id="episodes" className="mt-10 scroll-mt-24">
            <h2 className="mb-3 text-xl font-bold">Where to watch</h2>
            <Anivexa key={id} title={title} mediaId={id} cover={media.coverImage?.large} durationMinutes={media.duration} />
            <details className="mb-6"><summary className="cursor-pointer text-sm text-zinc-400">AnimePahe (manual verification)</summary><AnimePahe key={id} title={title} mediaId={id} /></details>
            <p className="mb-4 text-sm text-zinc-400">Episode links supplied by AniList open on the provider's website. Availability varies by region.</p>
            {streamError && <p role="alert" className="mb-3 text-sm text-red-400">{streamError}</p>}
            {media.streamingEpisodes?.some((episode) => episode.url?.startsWith("https://")) ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {media.streamingEpisodes.filter((episode) => episode.url?.startsWith("https://")).map((episode, index) => (
                  <button key={`${episode.url}-${index}`} onClick={() => {
                    setStreamError(null);
                    void openStreamUrl(episode.url!).catch((e: unknown) => setStreamError(e instanceof Error ? e.message : String(e)));
                  }} className="flex items-center gap-3 rounded-lg bg-zinc-800 p-3 text-left transition hover:bg-zinc-700">
                    <Play className="size-4 shrink-0" />
                    <span><span className="block text-sm font-medium">{episode.title || `Episode ${index + 1}`}</span><span className="text-xs text-zinc-400">{episode.site || "Open provider"} ↗</span></span>
                  </button>
                ))}
              </div>
            ) : <p className="text-sm text-zinc-400">AniList has no episode links for this title.</p>}
          </section>

          {/* Trailer */}
          {media.trailer?.site === "youtube" && (
            <div className="mt-10">
              <h2 className="mb-3 text-xl font-bold">Trailer</h2>
              <div className="aspect-video max-w-3xl overflow-hidden rounded-xl">
                <iframe
                  src={`https://www.youtube.com/embed/${media.trailer.id}`}
                  title={`${title} trailer`}
                  className="size-full"
                  allowFullScreen
                  loading="lazy"
                />
              </div>
            </div>
          )}

          {/* Characters */}
          {media.characters?.edges && media.characters.edges.length > 0 && (
            <div className="mt-10">
              <h2 className="mb-3 text-xl font-bold">Top Characters</h2>
              <div className="no-scrollbar flex gap-4 overflow-x-auto pb-2">
                {media.characters.edges.slice(0, 12).map(({ node }) => (
                  <div key={node.id} className="w-24 shrink-0 text-center">
                    {node.image?.large ? (
                      <img src={node.image.large} alt={node.name.full ?? ""} className="mx-auto size-20 rounded-full object-cover" />
                    ) : (
                      <div className="mx-auto size-20 rounded-full bg-zinc-800" />
                    )}
                    <p className="mt-2 truncate text-xs font-medium">{node.name.full}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <aside className="min-w-0 space-y-4 break-words text-sm">
          {media.studios?.nodes?.length ? (
            <div>
              <h3 className="text-zinc-500 text-xs uppercase tracking-wide">Studio</h3>
              <p className="mt-1">{media.studios.nodes.map((s) => s.name).join(", ")}</p>
            </div>
          ) : null}
          {media.title.romaji && media.title.english && (
            <div>
              <h3 className="text-zinc-500 text-xs uppercase tracking-wide">Romaji</h3>
              <p className="mt-1">{media.title.romaji}</p>
            </div>
          )}
          {media.title.native && (
            <div>
              <h3 className="text-zinc-500 text-xs uppercase tracking-wide">Japanese</h3>
              <p className="mt-1">{media.title.native}</p>
            </div>
          )}
          {media.popularity && (
            <div>
              <h3 className="text-zinc-500 text-xs uppercase tracking-wide">Popularity</h3>
              <p className="mt-1">{media.popularity.toLocaleString()}</p>
            </div>
          )}
        </aside>
      </div>
    </motion.main>
  );
}
