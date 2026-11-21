# Changelog

All notable changes to MEGU are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-11-21

### Added

- Loopback HTTP stream proxy (`127.0.0.1` ephemeral port): HLS and direct MP4 streams now play over
  local HTTP with real `Range` requests, playlist rewriting, DNS-rebinding/Origin guards, connection
  and per-session concurrency limits, idle timeouts, and immediate cancellation on player close.
- Direct MP4/WebM playback inside the in-app player (ranked below HLS and above embeds), unblocking
  MP4-only providers.
- Official streaming links from AniList (`externalLinks` of type `STREAMING`) under "Where to watch".

### Changed

- Provider fallback now probes health-ranked candidates concurrently (up to 4 at once) with a 12s
  per-request timeout and prefers providers matching AniList's expected episode count over fast
  partial episode lists.
- Updated npm and Cargo minor dependencies (Dependabot PRs #14 and #15).

### Fixed

- Canonicalized stream hostnames in URL validation so trailing-dot hostnames cannot bypass DNS
  pinning.
- Preserved bounded `200` → `206` byte-range slicing when a CDN ignores `Range` headers.
- Stale auto-fallback probes are aborted on selection change, empty player results are retryable,
  and `DirectHlsPlayer` rechecks disposal after awaiting the proxy URL.

## [0.2.0] - 2026-11-20

### Added

- Provider health scoring: tracks success and failure streaks per server and decays penalties after
  20 minutes so failed providers can be retried.
- Automatic failover: when a player fails, MEGU automatically tries the next ranked provider or
  fallback player without losing your place. Manual "Try next source" button available in the player.
- Safe CDN redirect handling: stream proxy now allows redirects within public HTTPS and validates
  CDN hosts referenced by playlists so HLS streams work reliably across CDN failovers.
- Embed hardening: WebView pop-ups are blocked, navigation is restricted to the initial provider
  domain or explicit human-verification hosts (Cloudflare, hCaptcha, reCAPTCHA, DDoS-Guard).
- Enhanced player health detection: probe distinguishes verification challenges, loading delays,
  and fatal errors so false failovers are avoided.

### Changed

- Direct HLS streams now rank above embeds. Direct MP4 support deferred pending ranged-read
  implementation (was limited to 16 MiB buffering).

### Fixed

- Embed navigation no longer uses registrable-domain matching, which was too broad (all `.co.uk`
  sites appeared same-site). Now uses strict subdomain-only checks.
- False-positive `dead` health detection no longer fires on pages titled "Episode 404" or on pre-roll
  videos; only confirmed error pages with short bodies trigger failover.
- Fallback provider probes are no longer cancelled by health updates that arrive mid-search.
- Sub/Dub cache no longer drops the other audio track when switching tracks on the same provider.

### Known limitations

- MP4 playback currently unavailable (deferred to next release pending ranged-read support).
- Fallback provider selection is automatic and silent; users cannot currently preview alternatives
  before switching.

## [0.1.2] - 2026-11-13

### Changed

- Updated frontend runtime dependencies and build tooling.

## [0.1.1] - 2026-11-05

### Added

- Update settings with automatic or manual checks, optional background downloads, and signed
  in-app installation for NSIS builds.
- Signed updater artifacts in the Windows release workflow.

### Fixed

- Restore the previous window fullscreen state when closing the episode player.

### Known limitations

- Existing 0.1.0 users need to install this version manually before they can use in-app updates.
- MSI installations must update manually from GitHub Releases.
- Installers are not Windows code-signed, so SmartScreen may show a warning.

## [0.1.0] - 2026-11-04

First public beta release.

### Added

- AniList catalogue browsing: trending, top rated, seasonal, popular, search and detail pages.
- Netflix-style dark interface with hero carousel, animated cards and shared-element detail
  transitions.
- AniList OAuth through a loopback redirect, with the token stored in Windows Credential Manager.
- Full list editor: status, episodes, score in the account's preferred format, advanced scores,
  rewatches, notes, privacy, custom lists, hide-from-status-lists, favourites and partial start and
  finish dates.
- Offline list snapshot per account, queued progress edits with automatic retry, and a sync review
  centre that compares local, base and remote values before overwriting anything.
- Continue Watching with per-account, per-provider playback positions, a resume prompt and 90%
  AniList progress updates that never lower existing progress.
- Direct HLS playback through hls.js and provider players in an isolated child webview, including
  nested-frame playback tracking.
- Weekly airing schedule with per-day navigation, local broadcast times and a clear note that
  airing does not guarantee streaming availability.
- Episode countdowns on list cards and optional Windows airing reminders.
- Discovery filters for genre, season, year and format, with pagination.
- Provider diagnostics explaining missing episodes, unavailable players, verification and
  untrackable playback.
- Bounded offline artwork cache for AniList covers and banners.
- NSIS installer with a **MEGU** Start menu entry, the MEGU icon for the setup and uninstaller, and
  an optional desktop shortcut; the installed binary is `MEGU.exe`, so it no longer appears as a
  stray `megu.exe`.
- Unit tests for list mutations, sync queues, playback tracking, provider parsing and artwork host
  validation.

### Known limitations

- Windows notifications require the app to be open, online and signed in.
- Streaming availability and playback tracking depend on third-party providers.
- Builds are unsigned, so Windows SmartScreen may warn on first launch.

[Unreleased]: ../../compare/v0.1.2...HEAD
[0.1.2]: ../../compare/v0.1.1...v0.1.2
[0.1.1]: ../../compare/v0.1.0...v0.1.1
[0.1.0]: ../../releases/tag/v0.1.0
