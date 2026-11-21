/**
 * The desktop app runs a loopback HTTP proxy (see src-tauri/src/local_proxy.rs)
 * so the in-app player can load stream video from a local network address with
 * real HTTP Range requests. Every path segment is percent-encoded, so the
 * upstream URL survives as a single path component.
 */
export function proxyStreamUrl(base: string, session: string, url: string): string {
  if (!/^https?:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error("Invalid stream proxy address");
  if (!/^[A-Za-z0-9-]{1,100}$/.test(session)) throw new Error("Invalid stream session");
  return `${base}/p/${encodeURIComponent(session)}/${encodeURIComponent(url)}`;
}
