import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, useState, useEffect } from "react";
import type { Media } from "../lib/anilist";
import { Card } from "./Card";

interface RowProps {
  title: string;
  subtitle?: string;
  items: Media[];
  loading?: boolean;
  error?: string | null;
}

export default function Row({ title, subtitle, items, loading, error }: RowProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(true);

  const updateArrows = () => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 8);
    setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 8);
  };

  useEffect(() => {
    updateArrows();
    const el = ref.current;
    // A mouse wheel should move down the page, not sideways through a carousel.
    // Horizontal trackpad gestures and Shift+wheel remain available for the row.
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey || event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const factor = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? window.innerHeight : 1;
      window.scrollBy({ top: event.deltaY * factor, behavior: "instant" });
    };
    el?.addEventListener("scroll", updateArrows, { passive: true });
    el?.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el?.removeEventListener("scroll", updateArrows);
      el?.removeEventListener("wheel", onWheel);
    };
  }, [items]);

  const scroll = (dir: 1 | -1) => {
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: "smooth" });
  };

  return (
    <section className="relative mb-10 px-4 sm:px-8 max-w-[1600px] mx-auto w-full">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-lg font-bold tracking-tight sm:text-xl">{title}</h2>
        {subtitle && <span className="text-xs text-zinc-500">{subtitle}</span>}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="group/row relative">
        <button
          onClick={() => scroll(-1)}
          disabled={!canLeft}
          aria-label="Scroll left"
          className="absolute left-0 top-1/2 z-20 -translate-y-1/2 rounded-full bg-black/70 p-2 opacity-0 transition-opacity group-hover/row:opacity-100 disabled:hidden hover:bg-black"
        >
          <ChevronLeft className="size-5" />
        </button>

        <div
          ref={ref}
          className="no-scrollbar flex gap-3 overflow-x-auto scroll-smooth pb-2 pt-1"
          onMouseEnter={updateArrows}
        >
          {loading
            ? Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="w-36 shrink-0 animate-pulse rounded-lg bg-zinc-800 md:w-40">
                  <div className="aspect-[3/4] w-full" />
                </div>
              ))
            : items.map((m, i) => <Card key={m.id} media={m} index={i} />)}
        </div>

        <button
          onClick={() => scroll(1)}
          disabled={!canRight}
          aria-label="Scroll right"
          className="absolute right-0 top-1/2 z-20 -translate-y-1/2 rounded-full bg-black/70 p-2 opacity-0 transition-opacity group-hover/row:opacity-100 disabled:hidden hover:bg-black"
        >
          <ChevronRight className="size-5" />
        </button>
      </div>
    </section>
  );
}
