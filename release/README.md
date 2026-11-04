# Release artifacts

Ready-to-use Windows builds of MEGU live in this folder after `npm run tauri build`:

| File | Use |
|:--|:--|
| `MEGU_<version>_x64-setup.exe` | **Recommended.** NSIS installer: adds MEGU to the Start menu, offers a desktop shortcut (ticked by default), and installs per user |
| `MEGU_<version>_x64_en-US.msi` | MSI package for managed or scripted installs (Start menu shortcut only) |
| `SHA256SUMS.txt` | Checksums for both installers |

Verify a download before running it:

```powershell
Get-FileHash .\MEGU_0.1.0_x64-setup.exe -Algorithm SHA256
```

Compare the result with the matching line in `SHA256SUMS.txt`. Builds are not code-signed, so
Windows SmartScreen may show a warning; only bypass it when the checksum matches.

## Publishing a release

For a public release, upload these files to a GitHub Release rather than committing them to the
repository. Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds the installers on
Windows and creates a draft release with them attached.

```powershell
# Bump the version in package.json AND src-tauri/tauri.conf.json, update CHANGELOG.md, then:
git commit -am "Release 0.1.1"
git tag v0.1.1
git push origin main --tags
```
