# Changelog

All notable changes to MEGU are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: ../../compare/v0.1.1...HEAD
[0.1.1]: ../../compare/v0.1.0...v0.1.1
[0.1.0]: ../../releases/tag/v0.1.0
