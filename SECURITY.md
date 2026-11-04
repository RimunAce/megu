# Security policy

## Supported versions

MEGU is in beta. Security fixes target the latest release only.

| Version | Supported |
|:--|:--|
| Latest release | Yes |
| Older releases | No |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting flow: repository **Security → Advisories → Report a vulnerability**.
If that is unavailable, open a minimal public issue asking a maintainer for a private channel and
share no details until one is arranged.

Helpful reports include:

- MEGU version and Windows version;
- a description of the impact (data loss, token exposure, command execution, provider escape…);
- steps to reproduce, and whether an account or a specific provider is required;
- any evidence (screenshots, logs) with personal data removed.

You can expect an acknowledgement within a few days, an assessment of severity, and credit in the
release notes if you would like it.

## Security model

MEGU is a local Windows app. Its threat model assumes that AniList responses and streaming provider
pages may be malicious or broken.

- The AniList access token and client secret live in **Windows Credential Manager**, never in the
  SQLite database, `localStorage`, installed files or logs.
- Provider pages are hosted in an isolated child webview without access to privileged Tauri commands.
- Direct HLS streams must be public HTTPS on the selected host; cross-host redirects and segments
  are refused.
- Artwork caching accepts only `https://s4.anilist.co` with no credentials, port or redirects, and
  caps downloads at 5 MB per image with a 50 MB / 300-image total budget.
- Commands validate their input before touching SQLite or the filesystem.

## Out of scope

- Streams, subtitles and player behaviour supplied by third-party providers.
- AniList account issues, rate limits or API outages.
- Antivirus or SmartScreen warnings caused by the absence of a code-signing certificate.
- Vulnerabilities that require an attacker to already control your Windows account or local files.
