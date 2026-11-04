import { AnimatePresence, motion } from "framer-motion";
import { Info, Play } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { displayTitle, type Media } from "../lib/anilist";
import { useAppStore } from "../store/app";

const ROTATE_MS = 6000;

export default function Hero({ items }: { items: Media[] }) {
  const openDetail = useAppStore((s) => s.openDetail);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const current = items[index];

  const advance = useCallback(() => {
    setIndex((i) => (i + 1) % Math.min(items.length, 5));
  }, [items.length]);

  useEffect(() => {
    if (paused || items.length === 0) return;
    const t = setTimeout(advance, ROTATE_MS);
    return () => clearTimeout(t);
  }, [advance, index, paused, items.length]);

  if (!current) return null;

  const banner = current.bannerImage || current.coverImage?.extraLarge;

  return (
    <div
      className="relative h-[70vh] min-h-[480px] w-full overflow-hidden"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={current.id}
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.7 }}
          className="absolute inset-0"
        >
          {banner && <img src={banner} alt="" className="size-full object-cover object-top" />}
          <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/30 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-t from-[--color-base] via-transparent to-transparent" />
        </motion.div>
      </AnimatePresence>

      {/* Content */}
      <div className="relative z-10 flex h-full max-w-[1600px] flex-col justify-end px-4 pb-24 sm:px-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={`text-${current.id}`}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.4 }}
          >
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-widest text-zinc-300">
              <span className="rounded-sm bg-[--color-accent] px-1.5 py-0.5">TOP 10</span>
              <span>#{index + 1} TRENDING TODAY</span>
            </div>
            <h1 className="max-w-2xl text-4xl font-black leading-tight drop-shadow-xl sm:text-5xl lg:text-6xl">
              {displayTitle(current.title)}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-zinc-200">
              {current.averageScore && (
                <span className="text-green-400 font-semibold">{(current.averageScore / 10).toFixed(1)}</span>
              )}{" "}
              {current.seasonYear && <span>{current.seasonYear}</span>}
              {current.format && <span className="rounded border border-zinc-500 px-1.5">{current.format}</span>}
              {current.episodes && <span>{current.episodes} Episodes</span>}
              {current.genres?.slice(0, 3).map((g) => (
                <span key={g} className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{g}</span>
              ))}
            </div>
            {current.description && (
              <p className="mt-3 line-clamp-3 max-w-xl text-sm text-zinc-300">
                {/* AniList descriptions contain simple HTML, so strip tags */}
                {current.description.replace(/<[^>]*>/g, "")}
              </p>
            )}
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => openDetail(current.id)}
                className="flex items-center gap-2 rounded-md bg-white px-6 py-2.5 font-semibold text-black transition hover:bg-white/80"
              >
                <Play className="size-5 fill-black" /> Watch
              </button>
              <button
                onClick={() => openDetail(current.id)}
                className="flex items-center gap-2 rounded-md bg-zinc-600/60 px-6 py-2.5 font-semibold text-white backdrop-blur transition hover:bg-zinc-600/80"
              >
                <Info className="size-5" /> More Info
              </button>
            </div>
          </motion.div>
        </AnimatePresence>

        {/* Indicators */}
        <div className="absolute bottom-6 right-8 flex gap-2">
          {items.slice(0, 5).map((_, i) => (
            <button
              key={i}
              onClick={() => setIndex(i)}
              aria-label={`Go to slide ${i + 1}`}
              className={`h-1.5 rounded-full transition-all ${i === index ? "w-8 bg-[--color-accent]" : "w-3 bg-white/40 hover:bg-white/70"}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
