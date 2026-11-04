import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { cacheArtwork, getCachedArtwork } from "../lib/artwork";

export default function CachedImage({ src, ...props }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [saved, setSaved] = useState<{ url: string; data: string } | null>(null);
  useEffect(() => {
    let active = true;
    void getCachedArtwork(src).then((data) => {
      if (active && data) setSaved({ url: src, data });
      if (!data && navigator.onLine) void cacheArtwork(src).catch(() => {});
    }).catch(() => {});
    return () => { active = false; };
  }, [src]);
  return <img {...props} src={saved?.url === src ? saved.data : src} />;
}
