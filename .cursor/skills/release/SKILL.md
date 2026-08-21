---
name: release
description: Build and publish Cosmic Launcher Windows and Linux releases to GitHub. Use when the user types /release, asks to release this version, build and release, publish to GitHub, or create a new GitHub release for CosmicLauncher.
---

# Cosmic Launcher Release

Release Cosmic Launcher on GitHub the same way every time.

## Triggers

Run this workflow when the user says any of:

- `/release`
- "release this version"
- "build and release"
- "publish to GitHub"

## Preconditions

1. Work from repo root: `CosmicLauncher/`
2. Ensure pending code changes are committed and pushed first (unless the user only asked to rebuild/republish the current version).
3. Confirm `package.json` version matches the release the user wants. If not specified, bump the **patch** version (example: `0.1.6` → `0.1.7`).
4. Update both `package.json` and `package-lock.json` (`npm install --package-lock-only` after editing version).
5. Commit and push the version bump before building.

## Build

On Windows, build both installers (NSIS locally, Linux `.deb` via WSL):

```powershell
npm run build
```

Single-platform:

```powershell
npm run build:win
npm run build:linux
```

Expected output in `dist/`:

- `Cosmic.Launcher.Setup.{version}.exe` (NSIS installer, x64 + ia32)
- `Cosmic.Launcher.Setup.{version}.exe.blockmap`
- `latest.yml`
- `Cosmic.Launcher-{version}-x64.deb`
- `latest-linux.yml`

`dist/` is gitignored — do not commit build artifacts.

Linux packaging uses WSL. `npm run build` and `npm run build:linux` copy sources into `~/.cache/cosmic-launcher-linux-build` inside WSL so Windows `node_modules` are not reused. The WSL script must use Linux Node/npm (not Windows binaries from PATH interop) and `fakeroot` for `.deb` packaging.

## GitHub release format (match existing releases)

Inspect the latest release first:

```powershell
$env:GH_TOKEN = (( "protocol=https`nhost=github.com`n" | git credential fill | Select-String '^password=').Line -split '=',2)[1]
& "C:\Program Files\GitHub CLI\gh.exe" release view v0.1.6
```

Existing releases use:

| Field | Value |
|-------|-------|
| Tag | `v{version}` (example: `v0.1.7`) |
| Title | `v{version}` |
| Prerelease | `true` |
| Windows asset | `Cosmic.Launcher.Setup.{version}.exe` |
| Linux asset | `Cosmic.Launcher-{version}-x64.deb` |
| Body | `## What's Changed` bullets + compare link |

If electron-builder still writes `Cosmic Launcher Setup {version}.exe`, copy it to the GitHub asset name before upload:

```powershell
Copy-Item "dist/Cosmic Launcher Setup 0.1.7.exe" "dist/Cosmic.Launcher.Setup.0.1.7.exe" -Force
```

Replace `0.1.7` with the target version. Prefer the dotted NSIS `artifactName` when it is already present.

## Tag, push, publish

```powershell
git tag -a v0.1.7 -m "Short release summary."
git push origin v0.1.7
```

Release notes template (save to a temp file under `dist/`, gitignored):

```markdown
## What's Changed
* <main change 1>
* <main change 2>
* <main change 3>

**Full Changelog**: https://github.com/ImTheLeviDR/CosmicLauncher/compare/v{prev}...v{version}
```

Fill bullets from `git log v{prev}..HEAD --oneline`. Use the previous tag as `{prev}`.

Create the release with Windows and Linux assets:

```powershell
$env:GH_TOKEN = (( "protocol=https`nhost=github.com`n" | git credential fill | Select-String '^password=').Line -split '=',2)[1]
& "C:\Program Files\GitHub CLI\gh.exe" release create v0.1.7 "dist/Cosmic.Launcher.Setup.0.1.7.exe" "dist/Cosmic.Launcher-0.1.7-x64.deb" --title "v0.1.7" --prerelease --notes-file "dist/release-notes-v0.1.7.md"
```

## GitHub CLI auth (Windows)

If `gh` is missing, install it:

```powershell
winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
```

If `gh auth status` fails, authenticate with the token from Git credential manager:

```powershell
$env:GH_TOKEN = (( "protocol=https`nhost=github.com`n" | git credential fill | Select-String '^password=').Line -split '=',2)[1]
```

Use `"C:\Program Files\GitHub CLI\gh.exe"` if `gh` is not on PATH yet.

## Checklist

```
Release progress:
- [ ] Code committed and pushed
- [ ] Version bumped in package.json + package-lock.json
- [ ] Version bump committed and pushed
- [ ] npm run build succeeded (Windows installer + Linux .deb via WSL)
- [ ] Windows asset named Cosmic.Launcher.Setup.{version}.exe
- [ ] Linux asset named Cosmic.Launcher-{version}-x64.deb
- [ ] Annotated tag v{version} created and pushed
- [ ] GitHub prerelease created with Windows and Linux assets
- [ ] Release URL returned to user
```

## Notes

- Remote: `https://github.com/ImTheLeviDR/CosmicLauncher.git`
- Upload the `.exe` and `.deb` assets. Do not upload blockmap or `latest.yml` / `latest-linux.yml` unless the user asks.
- `index_compiled.html` is regenerated at app startup from `index.ejs`; it does not need to be committed for releases.
- Do not commit secrets or echo `GH_TOKEN` in output.
