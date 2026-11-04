# Maintaining MEGU

Notes for whoever publishes and ships MEGU. Contributors do not need this file.

## One-time repository setup

After pushing the first commit to `https://github.com/RimunAce/megu`:

1. In the About panel, set the description to “A Windows anime app for AniList” and add the topics
   `anime`, `anilist`, `tauri`, `react`, `windows` and `desktop-app`. The website is optional.
2. Under Actions, allow workflows. The `CI` workflow must pass before merging.
3. Protect `main`:
   - require a pull request (1 approval) and a passing `check` status;
   - require branches to be up to date;
   - block force pushes and deletion;
   - optionally require linear history and signed commits.
4. Protect `v*` tags so only maintainers can move a release tag.
5. Under Settings, then Code security, enable:
   - private vulnerability reporting (the `SECURITY.md` link relies on it);
   - Dependabot alerts, security updates and the dependency graph;
   - secret scanning and push protection;
   - CodeQL (default setup) if you want scheduled scanning.
6. Discussions are optional. They suit “how do I…?” questions that are not bugs.
7. Keep releases immutable. Upload the installers and `SHA256SUMS.txt`; do not commit binaries to the
   repository.

## Release checklist

1. `npm run build`, `npm test`, `npm run lint`, `cargo test` in `src-tauri` all pass.
2. Bump the version in **both** `package.json` and `src-tauri/tauri.conf.json`.
3. Update `CHANGELOG.md` (move items out of *Unreleased*, set the date).
4. `npm run tauri build`; smoke-test the installed app, not just the raw binary:
   - first-run login, My List, an offline edit, schedule and a playback provider;
   - Start menu entry reads **MEGU** and the setup icon is the MEGU mark.
5. Copy `MEGU_<version>_x64-setup.exe`, `MEGU_<version>_x64_en-US.msi` and `SHA256SUMS.txt`
   into `release/` for attachment.
6. Commit, tag `v<version>`, push `main` and the tag. The `Release` workflow builds on Windows
   and creates a **draft** release.
7. Review the draft, attach the checksums, and publish. Announce the download link.

## Code signing

Builds are currently unsigned, so SmartScreen warns. To remove the warning you need an OV/EV
code-signing certificate (or Azure Trusted Signing) and CI secrets. Tauri supports signing through
`bundle.windows.certificateThumbprint` (certificate in the Windows store) or
`bundle.windows.signCommand` (custom signing tool). Keep certificates and passwords in GitHub
secrets. Never commit `.pfx` or `.p12` files; `.gitignore` covers them on purpose.

## Data and privacy promises

- No telemetry, analytics or MEGU-operated server. Keep it that way unless the README, `SECURITY.md`
  and the privacy section change in the same pull request.
- The AniList token and client secret live only in Windows Credential Manager.
- Provider pages stay in isolated webviews with no app permissions; do not add capabilities for them
  in `src-tauri/capabilities/`.
- Artwork caching stays restricted to `s4.anilist.co` and the existing 50 MB / 300-image budget.

## Known hardening follow-ups

- **CSP**: `app.security.csp` is `null` (Tauri default). A production CSP is desirable, but it must
  be tested against HLS playback, the Tauri IPC bridge and local images before shipping; a wrong
  policy breaks the player silently. Track this before a 1.0 release.
- **Auto-update**: not implemented. Users must download new installers; document this in release
  notes. Adding `tauri-plugin-updater` requires signed update artifacts and a public key in the app.
- **Identifier**: `com.megu.app` ends in `.app`, which only matters for macOS. Changing it now would
  move `%APPDATA%\com.megu.app` and orphan local data; revisit if a macOS build is ever planned.
- **All-users install**: the NSIS installer defaults to per-user install. If you switch to
  `installMode: "both"`, test elevation and uninstall behaviour.

## Triage

- Reproduce with the latest release; ask for logs and provider/player details.
- Label with `bug`, `enhancement`, `provider`, `offline`, `security` as appropriate.
- Treat “provider does not work” as an upstream issue unless MEGU can explain or avoid it.
- Close stale reports with a clear reason; never close a data-loss report without a root cause.
