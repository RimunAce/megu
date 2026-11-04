import { AnimatePresence, motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, KeyRound, Loader2, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getViewer } from "../lib/anilist";
import {
  getClientId,
  cancelOAuth,
  isTauri,
  openStreamUrl,
  setClientId as persistClientId,
  startOAuth,
} from "../lib/tauri";
import { useAppStore, useAuthStore } from "../store/app";
import meguWordmark from "../assets/megu-wordmark.png";

type Step = "setup" | "waiting" | "done" | "error";

export default function LoginModal() {
  const { loginOpen, setLoginOpen } = useAppStore();
  const { setSession } = useAuthStore();
  const queryClient = useQueryClient();

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [step, setStep] = useState<Step>("setup");
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const attempt = useRef<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (loginOpen && isTauri) {
      getClientId()
        .then((saved) => saved && setClientId(saved))
        .catch(() => {});
    }
    if (loginOpen) {
      setStep("setup");
      setError(null);
    }
  }, [loginOpen]);

  const close = async () => {
    if (cancelling) return;
    generation.current++;
    const id = attempt.current;
    attempt.current = null;
    if (id) {
      setCancelling(true);
      try { await cancelOAuth(id); }
      catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStep("error");
        setCancelling(false);
        return;
      }
      setCancelling(false);
    }
    setLoginOpen(false);
  };

  const onLogin = async () => {
    setError(null);
    setStep("waiting");
    const id = crypto.randomUUID();
    const current = ++generation.current;
    attempt.current = id;
    try {
      const { access_token } = await startOAuth(clientId.trim(), clientSecret.trim(), id);
      if (generation.current !== current) return;
      attempt.current = null;
      await persistClientId(clientId.trim());
      const viewer = await getViewer(access_token);
      if (generation.current !== current) return;
      setSession(access_token, viewer);
      // Refresh everything that depends on the account.
      queryClient.invalidateQueries({ queryKey: ["userList"] });
      queryClient.invalidateQueries({ queryKey: ["mediaListEntry"] });
      setStep("done");
      setTimeout(() => { if (generation.current === current) setLoginOpen(false); }, 1200);
    } catch (e) {
      if (generation.current !== current) return;
      attempt.current = null;
      setError(e instanceof Error ? e.message : typeof e === "string" ? e : "Login failed");
      setStep("error");
    }
  };

  return (
    <AnimatePresence>
      {loginOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => void close()}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 12 }}
            transition={{ type: "spring", stiffness: 400, damping: 28 }}
            className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-start justify-between">
              <div className="flex items-center gap-2">
                <img src={meguWordmark} alt="" className="size-12 object-contain" />
                <h2 className="text-lg font-bold">Connect AniList</h2>
              </div>
              <button
                onClick={() => void close()}
                disabled={cancelling}
                className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-40"
                aria-label="Close"
              >
                <X className="size-5" />
              </button>
            </div>

            {step === "setup" || step === "error" ? (
              <>
                {error && (
                  <p className="mb-3 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-sm text-red-300">
                    {error}
                  </p>
                )}
                <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-zinc-400">
                  <li>
                    Go to{" "}
                    <a
                      href="https://anilist.co/settings/developer"
                      target="_blank"
                      rel="noreferrer"
                      onClick={(event) => {
                        if (!isTauri) return;
                        event.preventDefault();
                        void openStreamUrl("https://anilist.co/settings/developer").catch((e: unknown) => {
                          setError(`Could not open AniList settings: ${e instanceof Error ? e.message : String(e)}`);
                        });
                      }}
                      className="inline-flex items-center gap-0.5 text-white underline decoration-zinc-600 hover:decoration-[--color-accent]"
                    >
                      anilist.co/settings/developer <ExternalLink className="size-3" />
                    </a>{" "}
                    and create an app with redirect URI{" "}
                    <code className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-200">
                      http://127.0.0.1:9420/callback
                    </code>
                  </li>
                  <li>Paste the Client ID and Client Secret below.</li>
                  <li>Click Connect, then approve access in the browser that opens.</li>
                </ol>

                <label className="mb-3 block">
                  <span className="mb-1 flex items-center gap-1 text-xs font-medium text-zinc-400">
                    <KeyRound className="size-3.5" /> Client ID
                  </span>
                  <input
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="e.g. 12345"
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm outline-none focus:border-[--color-accent]"
                  />
                </label>
                <label className="mb-5 block">
                  <span className="mb-1 text-xs font-medium text-zinc-400">
                    Client Secret
                  </span>
                  <input
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder="Your AniList application secret"
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm outline-none focus:border-[--color-accent]"
                  />
                </label>

                <button
                  onClick={onLogin}
                  disabled={!clientId.trim() || !clientSecret.trim() || !isTauri}
                  className="w-full rounded-lg bg-[--color-accent] py-2.5 text-sm font-semibold text-white transition hover:bg-[--color-accent-dim] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isTauri ? "Connect with AniList" : "Desktop app required"}
                </button>
                <p className="mt-3 text-center text-[11px] text-zinc-600">
                  Your token is stored in Windows Credential Manager, never in a plain file.
                </p>
              </>
            ) : step === "waiting" ? (
              <div className="flex flex-col items-center py-10 text-center">
                <Loader2 className="size-10 animate-spin text-[--color-accent]" />
                <p className="mt-4 font-medium">Waiting for you to approve in your browser...</p>
                <p className="mt-1 text-sm text-zinc-500">
                  Complete the login on AniList. This window closes automatically.
                </p>
                <button disabled={cancelling} onClick={() => void close()} className="mt-4 rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700 disabled:opacity-40">{cancelling ? "Cancelling…" : "Cancel login"}</button>
              </div>
            ) : (
              <div className="flex flex-col items-center py-10 text-center">
                <ShieldCheck className="size-10 text-green-400" />
                <p className="mt-4 font-medium">Signed in!</p>
                <p className="mt-1 text-sm text-zinc-500">Syncing your list...</p>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
