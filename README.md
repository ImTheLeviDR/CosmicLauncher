# Cosmic Launcher

A Minecraft launcher for Windows, macOS, and Linux. Sign in with Microsoft, keep separate instances, install Fabric mods from Modrinth, and launch the game from one window.

Current version: **0.1.2**

## Features

- **Microsoft account login** — Xbox / Minecraft authentication through Helios Core
- **Modpacks / instances** — each pack has its own game directory, mods, version, and loader
- **Vanilla and Fabric** — pick a Minecraft version and loader per pack
- **Modrinth mods** — search, install, enable/disable, and auto-update Fabric mods
- **Import from Modrinth App** — copy existing Modrinth instances into Cosmic Launcher
- **Play time tracking** — per-modpack session time, last played, and sort by play time
- **Launch options** — hide, exit, or keep the launcher open after Minecraft starts
- **Multiple instances** — optionally run more than one Minecraft session at once
- **Themes** — Cosmic, Nebula, Emerald, Crimson, Ocean, Sunset, Frost, Gold, Lavender, Midnight
- **Logs** — launcher and game output in Settings

## Download

Windows installers are published on [GitHub Releases](https://github.com/ImTheLeviDR/CosmicLauncher/releases).

Grab `Cosmic.Launcher.Setup.{version}.exe` (x64 + 32-bit NSIS installer).

You need a Microsoft account with a Minecraft Java Edition license, and Java available on your system (`java` on PATH).

## Development

Requires [Node.js](https://nodejs.org/) 18 or newer.

```bash
git clone https://github.com/ImTheLeviDR/CosmicLauncher.git
cd CosmicLauncher
npm install
npm start
```

The UI is `index.ejs`. On startup the Electron main process compiles it to `index_compiled.html` (dev) or into app user data (packaged).

## Build

```bash
npm run build:win     # Windows NSIS installer (x64 + ia32)
npm run build:mac     # macOS DMG (x64 + arm64)
npm run build:linux   # AppImage + deb (x64 + arm64)
```

Output goes to `dist/` (gitignored).

## Project layout

```
main.js                 Electron main process
preload.js              IPC bridge
index.ejs               Launcher UI
app/assets/js/
  authmanager.js        Microsoft / Minecraft auth
  launchmanager.js      Version install, Fabric, game launch
  modpackmanager.js     Instances and play time
  modmanager.js         Modrinth mod search / install
  modrinthimporter.js   Import from the Modrinth App
  configmanager.js      Launcher settings
```

Game data lives under the launcher directory: shared Minecraft files in `minecraft/`, per-pack worlds and mods in `instances/{id}/`.

## License

Private / unpublished unless a license file is added.
