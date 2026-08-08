---
name: release
description: Build and publish Cosmic Launcher Windows releases to GitHub. Use when the user types /release, asks to release this version, build and release, publish to GitHub, or create a new GitHub release for CosmicLauncher.
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
3. Confirm `package.json` version matches the release the user wants. If not specified, bump the **patch** version (example: `0.1.2` → `0.1.3`).
4. Update both `package.json` and `package-lock.json` (`npm install --package-lock-only` after editing version).
5. Commit and push the version bump before building.

## Build

```powershell
npm run build:win
```

Expected output in `dist/`:

- `Cosmic Launcher Setup {version}.exe` (NSIS installer, x64 + ia32)
- `Cosmic Launcher Setup {version}.exe.blockmap`
- `latest.yml`

`dist/` is gitignored — do not commit build artifacts.

## GitHub release format (match existing releases)

Inspect the latest release first:

```powershell
$env:GH_TOKEN = (( "protocol=https`nhost=github.com`n" | git credential fill | Select-String '^password=').Line -split '=',2)[1]
& "C:\Program Files\GitHub CLI\gh.exe" release view v0.1.2
```

Existing releases use:

| Field | Value |
|-------|-------|
| Tag | `v{version}` (example: `v0.1.2`) |
| Title | `v{version}` |
| Prerelease | `true` |
| Asset filename | `Cosmic.Launcher.Setup.{version}.exe` (dots, not spaces) |
| Body | `## What's Changed` bullets + compare link |

Copy the installer to the GitHub asset name before upload:

```powershell
Copy-Item "dist/Cosmic Launcher Setup 0.1.2.exe" "dist/Cosmic.Launcher.Setup.0.1.2.exe" -Force
```

Replace `0.1.2` with the target version.

## Tag, push, publish

```powershell
git tag -a v0.1.2 -m "Short release summary."
git push origin v0.1.2
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

Create the release:

```powershell
$env:GH_TOKEN = (( "protocol=https`nhost=github.com`n" | git credential fill | Select-String '^password=').Line -split '=',2)[1]
& "C:\Program Files\GitHub CLI\gh.exe" release create v0.1.2 "dist/Cosmic.Launcher.Setup.0.1.2.exe" --title "v0.1.2" --prerelease --notes-file "dist/release-notes-v0.1.2.md"
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
- [ ] npm run build:win succeeded
- [ ] Installer copied to Cosmic.Launcher.Setup.{version}.exe
- [ ] Annotated tag v{version} created and pushed
- [ ] GitHub prerelease created with installer asset
- [ ] Release URL returned to user
```

## Notes

- Remote: `https://github.com/ImTheLeviDR/CosmicLauncher.git`
- Only upload the `.exe` asset (same as v0.1.0 and v0.1.1); do not upload blockmap or `latest.yml` unless the user asks.
- `index_compiled.html` is regenerated at app startup from `index.ejs`; it does not need to be committed for releases.
- Do not commit secrets or echo `GH_TOKEN` in output.
