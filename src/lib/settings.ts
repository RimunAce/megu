export function settingEnabled(key: string, fallback = true) {
  try { const value = localStorage.getItem(key); return value === null ? fallback : value === "true"; } catch { return fallback; }
}
