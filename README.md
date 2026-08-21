# Cosmic Launcher

A Minecraft launcher for Windows and Linux. Sign in with Microsoft, keep separate instances, install Fabric mods from Modrinth, and launch the game from one window.

## Download

Installers are published on [GitHub Releases](https://github.com/ImTheLeviDR/CosmicLauncher/releases).

- **Windows:** `Cosmic.Launcher.Setup.{version}.exe` (x64 + 32-bit NSIS installer)
- **Linux:** `Cosmic.Launcher-{version}-amd64.deb` (Debian/Ubuntu x64)

On Linux:

```bash
sudo dpkg -i Cosmic.Launcher-*-amd64.deb
# or
sudo apt install ./Cosmic.Launcher-*-amd64.deb
```

You need a Microsoft account with a Minecraft Java Edition license, and Java available on your system (`java` on PATH, or `JAVA_HOME`).

Launcher data lives at `%APPDATA%\.cosmiclauncher` on Windows and `~/.cosmiclauncher` on Linux. Game data lives under that directory: shared Minecraft files in `minecraft/`, per-pack worlds and mods in `instances/{id}/`.

## Build

```bash
npm install
npm run build
```

On Windows, `npm run build` produces the NSIS installer and also builds the Linux `.deb` through WSL. Use `npm run build:win` or `npm run build:linux` for a single platform.

## License

Licensed under the [Apache License 2.0](LICENSE).
