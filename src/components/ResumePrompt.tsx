import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { formatTime, type PlaybackRecord } from "../lib/playback";

export default function ResumePrompt({ record, onYes, onNo, onCancel }: { record: PlaybackRecord; onYes: () => void; onNo: () => void; onCancel: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  useEffect(() => { cancel.current = onCancel; }, [onCancel]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); cancel.current(); return; }
      if (event.key !== "Tab" || !dialog.current) return;
      const buttons = [...dialog.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); previous?.focus(); };
  }, []);
  return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 p-4"><motion.div ref={dialog} initial={{ scale: 0.95, y: 12 }} animate={{ scale: 1, y: 0 }} role="dialog" aria-modal="true" aria-labelledby="resume-title" aria-label="Resume watching" className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl"><h3 id="resume-title" className="text-xl font-bold">Resume watching at {formatTime(record.position)}?</h3><p className="mt-2 text-sm text-zinc-400">Episode {record.episode} · {record.provider} · {record.server}</p><div className="mt-6 flex gap-3"><button onClick={onYes} className="flex-1 rounded-lg bg-white px-4 py-3 font-semibold text-black hover:bg-zinc-200">Yes</button><button onClick={onNo} className="flex-1 rounded-lg bg-zinc-700 px-4 py-3 font-semibold hover:bg-zinc-600">No</button></div><button onClick={onCancel} className="mt-4 text-sm text-zinc-400 underline">Cancel</button></motion.div></motion.div>;
}
