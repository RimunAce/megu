# Contributing to MEGU

Thanks for taking the time to help. MEGU is a small, opinionated app: a Rust/Tauri shell around a
React UI, with AniList as the source of truth. The notes below keep changes easy to review.

## Development setup

1. Install prerequisites (Windows):

   ```powershell
   winget install Rustlang.Rustup -e
   winget install Microsoft.VisualStudio.2022.BuildTools -e -- --add Microsoft.VisualStudio.Component.VC.Tools
   winget install OpenJS.NodeJS.LTS -e
   ```

2. Add `%USERPROFILE%\.cargo\bin` to `PATH` and restart your terminal.
3. Clone your fork and install dependencies:

   ```powershell
   npm install
   npm run tauri dev
   ```

Useful commands:

| Command | What it does |
|:--|:--|
| `npm run tauri dev` | Run the desktop app with hot reload |
| `npm run build` | Type-check and build the web bundle |
| `npm test` | Node test suites (sync, playback, providers, artwork rules) |
| `npm run lint` | oxlint |
| `cargo check` | Compile-check the Rust backend |
| `cargo test` | Backend unit tests |
| `npm run tauri build` | Produce MSI/NSIS installers |

## Before you open a pull request

- Keep the change focused. Unrelated refactors belong in a separate PR.
- Add or update tests for logic that can be tested without a network or a real provider:
  `tests/*.test.mjs` for TypeScript modules and `#[cfg(test)]` for Rust.
- Run `npm run build`, `npm test`, `npm run lint` and `cargo test`.
- Do not commit `dist/`, `node_modules/`, `src-tauri/target/`, tokens, client secrets or personal
  screenshots.
- Explain *why* in the PR description, and include before/after screenshots for UI changes.

## Code conventions

- TypeScript: strict types, no `any` unless unavoidable, prefer existing helpers in `src/lib`.
- React: hooks over classes; keep network and storage work in `src/lib`, not in components.
- Rust: return `Result<_, String>` from commands, validate all input from the webview, and never
  expose filesystem or shell access to provider pages.
- Styling: Tailwind utilities consistent with the surrounding file; no new design tokens without a
  reason.
- Theming: dark UI, red accent, rounded cards. Respect `prefers-reduced-motion` where animation is
  decorative.

## Behaviour that must not regress

These rules encode hard-won bug fixes. Please preserve them:

1. **Never lower AniList progress** automatically.
2. **Never send unedited fields** in `SaveMediaListEntry`; AniList may clear them.
3. **Check the remote base before syncing** a queued edit, and keep conflicts for review instead of
   overwriting them.
4. **Keep the local queue** when the app is offline or AniList fails.
5. **Airing is not availability.** Broadcast times must never be presented as guaranteed streams.
6. **Provider content is untrusted.** Do not grant it app commands, and keep stream/artwork hosts
   allowlisted (public HTTPS, same-host HLS, AniList CDN for artwork).
7. **Secrets stay in Windows Credential Manager**, never in SQLite, localStorage or logs.

## Reporting bugs

Open an issue with: MEGU version, Windows version, what you expected, what happened, and steps to
reproduce. For playback problems include the provider, audio track, player name and whether the
episode opens in a browser. Logs may contain titles and URLs, so remove personal information.

For security issues, follow [SECURITY.md](SECURITY.md) instead.

## Suggesting features

Open an issue describing the user problem first, not only the solution. Features that fit MEGU best:

- make the list more trustworthy (offline, conflicts, parity with AniList);
- explain provider failures instead of hiding them;
- stay lightweight and keyboard-friendly;
- respect user data and privacy by default.

## Commit messages

Short imperative subject, optional body explaining the trade-off:

```text
Keep queued edits when AniList rate-limits

A 429 previously dropped the manual queue for that title. Treat it like an
offline failure so the review center can still decide.
```

## Community

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Be kind, assume good
intent, and keep discussion about the code.

## License

Contributions are accepted under the [MIT License](LICENSE). By submitting a pull request you confirm
you have the right to license your contribution under those terms.
