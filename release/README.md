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

### Updater signing setup

The in-app updater verifies Tauri signatures. Before the first updater-enabled release,
generate a signing key with `npm run tauri signer generate -- -w <secure-path>` on a
trusted machine. Store and back up the private key and its password securely outside the
repository. Set the GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` to the private key
contents and, if used, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to its password. Set the
repository variable `MEGU_UPDATER_PUBLIC_KEY` to the matching public key contents. The
same public key is pinned in `src-tauri/tauri.conf.json` so the bundler and installed app
verify updates consistently; the release job checks that the GitHub variable matches.
Do not replace the key casually: installed builds trust the public key they were built
with. Losing the private key or rotating it without a migration requires users to install
another build manually. The release job fails if either key is missing.

The workflow creates signed updater artifacts and `latest.json` on the draft release.
Verify their signatures and test a real upgrade before publishing the draft. The updater
endpoint only serves published latest releases, not drafts. The updater manifest points
to the NSIS installer; MSI-to-NSIS upgrades have not been validated, so MSI users should
download the MSI manually until that migration has been tested. Tauri update signatures
are separate from Windows code signing and do not remove SmartScreen warnings.

Older MEGU builds do not contain an updater; install the first updater-enabled build
manually. Local builds use the public key pinned in the Tauri configuration.

For a public release, upload these files to a GitHub Release rather than committing them to the
repository. Pushing a `v*` tag runs `.github/workflows/release.yml`, which builds the installers on
Windows and creates a draft release with them attached.

```powershell
# Follow the release checklist in MAINTAINING.md and merge the version bump.
# On the updated main branch, tag the merged commit:
git tag v0.1.1
git push origin v0.1.1
```
