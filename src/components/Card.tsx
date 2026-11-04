import { motion } from "framer-motion";
import { Star } from "lucide-react";
import { memo } from "react";
import { displayTitle, type Media } from "../lib/anilist";
import { useAppStore } from "../store/app";
import CachedImage from "./CachedImage";

function CardInner({ media, index }: { media: Media; index: number }) {
  const openDetail = useAppStore((s) => s.openDetail);
  const title = displayTitle(media.title);
  const cover = media.coverImage?.extraLarge || media.coverImage?.large;
  const score = media.averageScore ? (media.averageScore / 10).toFixed(1) : null;

  return (
    <motion.button
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.04, 0.4) }}
      whileHover={{ scale: 1.05, zIndex: 10 }}
      whileTap={{ scale: 0.98 }}
      onClick={() => openDetail(media.id)}
      className="group relative w-36 shrink-0 overflow-hidden rounded-lg bg-[--color-card] text-left shadow-md outline-none ring-white/10 transition-shadow hover:shadow-2xl focus-visible:ring-2 md:w-40"
    >
      <div className="aspect-[3/4] w-full overflow-hidden bg-zinc-800">
        {cover ? (
          <CachedImage
            src={cover}
            alt={title}
            loading="lazy"
            className="size-full object-cover transition-transform duration-500 group-hover:scale-110"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-2xl font-bold text-zinc-600">
            {title.slice(0, 1)}
          </div>
        )}
      </div>

      {/* Gradient overlay with title */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent p-2 pt-8">
        <p className="truncate text-xs font-semibold">{title}</p>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-300">
          {score && (
            <span className="flex items-center gap-0.5 text-amber-400">
              <Star className="size-3 fill-amber-400" /> {score}
            </span>
          )}
          {media.seasonYear && <span>{media.seasonYear}</span>}
          {media.format && (
            <span className="rounded border border-zinc-500 px-1 text-[10px]">{media.format}</span>
          )}
        </div>
      </div>
    </motion.button>
  );
}

export const Card = memo(CardInner);
