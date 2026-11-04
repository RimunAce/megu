import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { drainAutoSync } from "../lib/autoSync";
import { useAuthStore } from "../store/app";
import { AnimatePresence, motion } from "framer-motion";
import { drainManualSync } from "../lib/manualSync";

export default function SyncManager() {
  const token = useAuthStore((s) => s.token);
  const userId = useAuthStore((s) => s.viewer?.id);
  const client = useQueryClient();
  const [notice, setNotice] = useState<{ message: string; kind: string } | null>(null);
  useEffect(() => {
    const onNotice = (event: Event) => setNotice((event as CustomEvent<{ message: string; kind: string }>).detail);
    window.addEventListener("megu-sync-notice", onNotice);
    return () => window.removeEventListener("megu-sync-notice", onNotice);
  }, []);
  useEffect(() => {
    if (!token || !userId) return;
    const invalidate = (id: number) => {
      void client.invalidateQueries({ queryKey: ["userList"] });
      void client.invalidateQueries({ queryKey: ["mediaListEntry", id] });
      void client.invalidateQueries({ queryKey: ["pendingProgress", userId] });
      void client.invalidateQueries({ queryKey: ["listSnapshot", userId] });
    };
    const drain = () => void drainManualSync(userId, token, invalidate).then(() => drainAutoSync(userId, token, invalidate));
    window.addEventListener("megu-autosync-queued", drain);
    window.addEventListener("megu-manualsync-queued", drain);
    window.addEventListener("online", drain);
    const timer = window.setInterval(drain, 60_000);
    drain();
    return () => { window.removeEventListener("megu-autosync-queued", drain); window.removeEventListener("megu-manualsync-queued", drain); window.removeEventListener("online", drain); clearInterval(timer); };
  }, [token, userId, client]);
  return <AnimatePresence>{notice && <motion.div initial={{ opacity: 0, y: 14, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8 }} role="status" className={`fixed bottom-5 right-5 z-[120] max-w-sm rounded-xl border bg-zinc-900 p-4 text-sm shadow-2xl ${notice.kind === "error" ? "border-amber-600 text-amber-200" : "border-emerald-600 text-emerald-200"}`}>{notice.message}<button className="ml-3 text-white" aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button></motion.div>}</AnimatePresence>;
}
