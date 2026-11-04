import { useState } from "react";
import { settingEnabled } from "../lib/settings";
import { isTauri } from "../lib/tauri";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";

const options = [
  { key: "megu.autoSync", title: "Automatically update AniList", description: "Update episode progress when playback reaches 90%. Never lowers your existing progress.", defaultValue: true },
  { key: "megu.home.continue", title: "Continue watching on home", description: "Show locally saved playback at the top of the home page.", defaultValue: true },
  { key: "megu.home.airing", title: "Recently aired", description: "Show the latest AniList airing schedule on home.", defaultValue: true },
  { key: "megu.home.top", title: "Top rated", description: "Show the all-time top-rated row on home.", defaultValue: true },
  { key: "megu.home.popular", title: "Most popular", description: "Show the popular titles row on home.", defaultValue: true },
];

export default function SettingsPage() {
  const [values, setValues] = useState(() => Object.fromEntries(options.map((o) => [o.key, settingEnabled(o.key, o.defaultValue)])));
  const [reminders, setReminders] = useState(() => settingEnabled("megu.airingNotifications", false));
  const [reminderError, setReminderError] = useState("");
  const toggleReminders = async (enabled: boolean) => {
    setReminderError("");
    if (enabled) {
      if (!isTauri) { setReminderError("Windows notifications are available in the desktop app."); return; }
      try { if (!await isPermissionGranted() && await requestPermission() !== "granted") { setReminderError("Notification permission was not granted. Check Windows notification settings."); return; } }
      catch (e) { setReminderError(`Could not enable notifications: ${String(e)}`); return; }
    }
    localStorage.setItem("megu.airingNotifications", String(enabled)); setReminders(enabled); window.dispatchEvent(new Event("megu-reminders-changed"));
  };
  return <main className="mx-auto max-w-3xl px-4 pb-16 pt-24 sm:px-8"><h1 className="text-3xl font-bold">Settings</h1><p className="mt-2 text-sm text-zinc-400">Customize playback and your home page on this device.</p><div className="mt-8 space-y-3">{options.map((option) => <label key={option.key} className="flex items-center justify-between gap-5 rounded-xl border border-zinc-800 bg-zinc-900 p-4"><span><span className="block font-semibold">{option.title}</span><span className="mt-1 block text-sm text-zinc-400">{option.description}</span></span><input type="checkbox" checked={values[option.key]} onChange={(e) => { const value = e.target.checked; localStorage.setItem(option.key, String(value)); setValues((old) => ({ ...old, [option.key]: value })); if (option.key === "megu.autoSync" && value) window.dispatchEvent(new Event("megu-autosync-queued")); }} className="size-5 shrink-0 accent-red-500" /></label>)}<label className="flex items-center justify-between gap-5 rounded-xl border border-zinc-800 bg-zinc-900 p-4"><span><span className="block font-semibold">Airing reminders</span><span className="mt-1 block text-sm text-zinc-400">Windows notifications for Watching, Planning and Repeating titles while MEGU is open and signed in. Airing does not guarantee streaming availability.</span>{reminderError && <span role="alert" className="mt-2 block text-sm text-red-300">{reminderError}</span>}</span><input type="checkbox" checked={reminders} onChange={(e) => void toggleReminders(e.currentTarget.checked)} className="size-5 shrink-0 accent-red-500" /></label></div><div className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900 p-4"><h2 className="font-semibold">Graphics acceleration</h2><p className="mt-1 text-sm text-zinc-400">MEGU uses the WebView2 runtime’s default hardware acceleration when your device and graphics drivers support it. Availability and video decoding are managed by Windows and the provider.</p></div></main>;
}
