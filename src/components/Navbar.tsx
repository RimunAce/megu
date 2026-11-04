import { AnimatePresence, motion } from "framer-motion";
import { Home, ListVideo, LogIn, Search, History, Settings, CalendarDays } from "lucide-react";
import { useEffect, useState } from "react";
import type { View } from "../store/app";
import { useAppStore, useAuthStore } from "../store/app";
import meguMark from "../assets/megu-mark.png";

const NAV: { id: View; label: string; icon: typeof Home }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "search", label: "Search", icon: Search },
  { id: "continue", label: "Continue Watching", icon: History },
  { id: "mylist", label: "My List", icon: ListVideo },
  { id: "schedule", label: "Schedule", icon: CalendarDays },
  { id: "settings", label: "Settings", icon: Settings },
];

export default function Navbar() {
  const { view, setView, query, setQuery, setView: go } = useAppStore();
  const setLoginOpen = useAppStore((s) => s.setLoginOpen);
  const viewer = useAuthStore((s) => s.viewer);
  const token = useAuthStore((s) => s.token);
  const [scrolled, setScrolled] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const active: View = view === "detail" ? "home" : view;

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 transition-colors duration-300 ${
        scrolled ? "bg-[--color-base]/95 backdrop-blur-md shadow-lg" : "bg-gradient-to-b from-black/70 to-transparent"
      }`}
    >
      <div className="mx-auto flex max-w-[1600px] min-w-0 items-center gap-2 px-4 py-3 sm:gap-4 sm:px-8 xl:gap-8">
        {/* Logo */}
        <button onClick={() => setView("home")} aria-label="MEGU home" className="flex items-center gap-1">
          <img src={meguMark} alt="" className="h-10 w-12 object-contain" />
          <span className="hidden text-xl font-black tracking-tight sm:inline">
            MEGU
          </span>
        </button>

        {/* Links */}
        <nav className="flex items-center gap-0 xl:gap-1">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => go(id)}
              className={`relative flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm font-medium transition-colors xl:px-3 ${
                active === id ? "text-white" : "text-zinc-400 hover:text-white"
              }`}
            >
              <Icon className="size-4" />
              <span className="hidden xl:inline">{label}</span><span className="sr-only xl:hidden">{label}</span>
              <AnimatePresence>
                {active === id && (
                  <motion.span
                    layoutId="nav-underline"
                    className="absolute -bottom-0.5 left-3 right-3 h-0.5 rounded-full bg-[--color-accent]"
                  />
                )}
              </AnimatePresence>
            </button>
          ))}
        </nav>

        {/* Search */}
        <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-4">
          <motion.div
            animate={{ width: focused ? 220 : 160 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className={`hidden max-w-full min-w-0 items-center gap-2 rounded-full border px-3 py-1.5 sm:flex ${
              focused ? "border-zinc-500 bg-zinc-800" : "border-zinc-700 bg-zinc-900/70"
            }`}
          >
            <Search className="size-4 shrink-0 text-zinc-400" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (e.target.value && view !== "search") go("search");
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Titles, genres..."
              className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-zinc-500"
            />
          </motion.div>

          {/* Profile / login */}
          {token && viewer ? (
            <button
              onClick={() => go("mylist")}
              className="flex items-center gap-2 rounded-full bg-zinc-800 p-1 pr-3 hover:bg-zinc-700 transition-colors"
              aria-label={viewer.name}
            >
              {viewer.avatar?.large ? (
                <img src={viewer.avatar.large} alt={viewer.name} className="size-7 rounded-full object-cover" />
              ) : (
                <span className="flex size-7 items-center justify-center rounded-full bg-[--color-accent] text-xs font-bold">
                  {viewer.name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="hidden max-w-24 truncate text-sm font-medium sm:inline">{viewer.name}</span>
            </button>
          ) : (
            <button
              onClick={() => setLoginOpen(true)}
              className="flex items-center gap-2 rounded-full bg-zinc-800 p-1 pl-3 hover:bg-zinc-700 transition-colors"
              aria-label="Log in with AniList"
            >
              <LogIn className="size-4 text-zinc-300" />
              <span className="hidden rounded-full bg-[--color-accent] px-2 py-0.5 text-xs font-semibold sm:inline">
                Login
              </span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
