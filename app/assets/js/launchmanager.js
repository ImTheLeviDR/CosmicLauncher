const { spawn } = require('child_process')
const fs = require('fs-extra')
const path = require('path')
const os = require('os')
const https = require('https')
const http = require('http')
const crypto = require('crypto')
const ConfigManager = require('./configmanager')
const ModpackManager = require('./modpackmanager')

const MINECRAFT_VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const FABRIC_META = "https://meta.fabricmc.net/v2";

class LaunchManager {
  constructor() {
    this.javaPath = "java";
    this.proc = null;
    this._exitCode = null;
    this._gameRunning = false;
    this._activeGameDir = null;
    this._playSessions = new Map();
    this._playFlushTimer = null;
    this._playTick = 0;
    this.on("progress", () => {});
    this.on("launch", () => {});
    this.on("log", () => {});
    this.on("gameLog", () => {});
    this.on("gameExit", () => {});
    this.on("playTime", () => {});
  }

  isGameRunning() {
    return this._gameRunning === true;
  }

  stopGame() {
    if (!this._gameRunning || !this.proc) {
      this._gameRunning = false;
      this.proc = null;
      return false;
    }

    const proc = this.proc;
    const pid = proc.pid;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        proc.kill("SIGTERM");
      }
    } catch (err) {
      this.log(`Failed to stop game process: ${err.message}`);
    }

    this._endPlaySession(pid);
    this._gameRunning = this._playSessions.size > 0;
    if (this.proc === proc) this.proc = null;
    this.emit("gameExit", { code: null, signal: "SIGTERM" });
    return true;
  }

  /** Shared store for versions / libraries / assets (not per-modpack). */
  getSharedMinecraftDirectory() {
    return path.join(ConfigManager.getLauncherDirectory(), "minecraft");
  }

  /** @deprecated Use getSharedMinecraftDirectory or getGameDirectory */
  getMinecraftDirectory() {
    return this._activeGameDir || this.getGameDirectory();
  }

  getGameDirectory(modpackId) {
    const id = modpackId || ModpackManager.getSelectedId();
    const dir = ModpackManager.getInstanceDirectory(id);
    fs.ensureDirSync(path.join(dir, "mods"));
    return dir;
  }

  getVanillaMinecraftDirectory() {
    const minecraftPath = path.join(
      os.homedir(),
      "AppData",
      "Roaming",
      ".minecraft",
    );
    if (process.platform === "darwin") {
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        ".minecraft",
      );
    }
    if (process.platform === "linux") {
      return path.join(os.homedir(), ".minecraft");
    }
    return minecraftPath;
  }

  migrateOptions(gameDir) {
    const vanillaDir = this.getVanillaMinecraftDirectory();
    const cosmicDir = gameDir || this.getGameDirectory();

    try {
      const vanillaOptions = path.join(vanillaDir, "options.txt");
      const cosmicOptions = path.join(cosmicDir, "options.txt");

      if (fs.existsSync(vanillaOptions) && !fs.existsSync(cosmicOptions)) {
        this.log(`Migrating options.txt from vanilla Minecraft`);
        fs.ensureDirSync(cosmicDir);
        fs.copyFileSync(vanillaOptions, cosmicOptions);
      }

      const resourcePacksDir = path.join(cosmicDir, "resourcepacks");
      const vanillaResourcePacks = path.join(vanillaDir, "resourcepacks");

      if (
        fs.existsSync(vanillaResourcePacks) &&
        !fs.existsSync(resourcePacksDir)
      ) {
        this.log(`Linking resourcepacks from vanilla Minecraft`);
        fs.ensureDirSync(cosmicDir);
        fs.symlinkSync(vanillaResourcePacks, resourcePacksDir, "junction");
      }
    } catch (err) {
      this.log(`Migration warning: ${err.message}`);
    }
  }

  prepareGameDirectory(modpackId) {
    const gameDir = this.getGameDirectory(modpackId);
    this._activeGameDir = gameDir;
    fs.ensureDirSync(path.join(gameDir, "mods"));

    const syncResult = ModpackManager.syncOptionsToInstance(modpackId || ModpackManager.getSelectedId());
    if (syncResult.synced) {
      this.log(`Synced options.txt from newest modpack instance`);
    }

    this.migrateOptions(gameDir);
    return gameDir;
  }

  getVersionsDirectory() {
    return path.join(this.getSharedMinecraftDirectory(), "versions");
  }

  getAssetsDirectory() {
    return path.join(this.getSharedMinecraftDirectory(), "assets");
  }

  getLibrariesDirectory() {
    return path.join(this.getSharedMinecraftDirectory(), "libraries");
  }

  async resolveVersionId(versionSpec) {
    if (versionSpec && versionSpec !== "latest") return versionSpec;
    const manifest = await this.getVersionManifest(true);
    const latest = manifest?.latest?.release || manifest?.versions?.find((v) => v.type === "release")?.id;
    if (!latest) throw new Error("Could not resolve latest Minecraft version");
    return latest;
  }

  log(message) {
    console.log("[LaunchManager] " + message);
    this.emit("log", message);
  }

  async downloadFile(url, destPath, onProgress, options = {}) {
    const { logStart = true, logComplete = true } = options;
    return new Promise((resolve, reject) => {
      fs.ensureDirSync(path.dirname(destPath));

      const file = fs.createWriteStream(destPath);
      const request = url.startsWith("https") ? https : http;

      if (logStart) {
        this.log(`Downloading: ${url}`);
        this.log(`Destination: ${destPath}`);
      }

      request
        .get(url, (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            file.close();
            fs.unlinkSync(destPath);
            this.downloadFile(
              response.headers.location,
              destPath,
              onProgress,
              options,
            )
              .then(resolve)
              .catch(reject);
            return;
          }

          const total = parseInt(response.headers["content-length"], 10);
          let downloaded = 0;

          response.on("data", (chunk) => {
            downloaded += chunk.length;
            if (onProgress && total) {
              onProgress(downloaded / total);
            }
          });

          response.pipe(file);
          file.on("finish", () => {
            file.close();
            if (logComplete) {
              this.log(`Download complete: ${destPath}`);
            }
            resolve();
          });
        })
        .on("error", (err) => {
          this.log(`Download error: ${err.message}`);
          if (fs.existsSync(destPath)) {
            fs.unlinkSync(destPath);
          }
          reject(err);
        });
    });
  }

  async fetchJson(url) {
    this.log(`Fetching JSON: ${url}`);
    return new Promise((resolve, reject) => {
      const request = url.startsWith("https") ? https : http;
      request
        .get(url, (response) => {
          let data = "";
          response.on("data", (chunk) => (data += chunk));
          response.on("end", () => {
            try {
              this.log(`JSON fetched successfully from ${url}`);
              resolve(JSON.parse(data));
            } catch (e) {
              this.log(`JSON parse error: ${e.message}`);
              reject(e);
            }
          });
        })
        .on("error", reject);
    });
  }

  async getVersionManifest(forceRefresh = false) {
    if (!forceRefresh) {
      const cached = ConfigManager.getCachedVersionManifest();
      if (cached) {
        this.log("Using cached version manifest");
        return cached;
      }
    }
    try {
      const manifest = await this.fetchJson(MINECRAFT_VERSION_MANIFEST);
      ConfigManager.cacheVersionManifest(manifest);
      return manifest;
    } catch (err) {
      const cached = ConfigManager.getCachedVersionManifest();
      if (cached) {
        this.log("Network unavailable, using cached version manifest");
        return cached;
      }
      throw err;
    }
  }

  async ensureVersion(versionId) {
    this.log(`Ensuring version: ${versionId}`);
    const versionDir = path.join(this.getVersionsDirectory(), versionId);
    const versionJson = path.join(versionDir, `${versionId}.json`);

    if (fs.existsSync(versionJson)) {
      this.log(`Version JSON already exists: ${versionJson}`);
      return JSON.parse(fs.readFileSync(versionJson, "utf-8"));
    }

    const manifest = await this.getVersionManifest();
    const versionInfo = manifest.versions.find((v) => v.id === versionId);

    if (!versionInfo) {
      this.log(`Version ${versionId} not found in manifest`);
      throw new Error(`Version ${versionId} not found`);
    }

    this.log(`Found version info: ${JSON.stringify(versionInfo)}`);

    this.emit("progress", { task: "Fetching version info", progress: 0 });

    const versionData = await this.fetchJson(versionInfo.url);
    this.log(`Version data fetched, mainClass: ${versionData.mainClass}`);

    fs.ensureDirSync(versionDir);
    fs.writeFileSync(versionJson, JSON.stringify(versionData, null, 4));

    return versionData;
  }

  async downloadLibraries(versionData) {
    const libs = versionData.libraries || [];
    let downloaded = 0;
    const total = libs.length;

    this.log(`Downloading ${total} libraries...`);

    for (const lib of libs) {
      if (!this.shouldDownloadLibrary(lib)) {
        this.log(`Skipping library (rule mismatch): ${lib.name}`);
        continue;
      }

      const url = this.getLibraryUrl(lib);
      const dest = path.join(
        this.getLibrariesDirectory(),
        this.getLibraryPath(lib),
      );

      if (fs.existsSync(dest)) {
        this.log(`Library already exists: ${dest}`);
      } else {
        try {
          await this.downloadFile(url, dest);
        } catch (e) {
          this.log(`Failed to download library: ${lib.name} - ${e.message}`);
        }
      }

      downloaded++;
      this.emit("progress", {
        task: "Downloading libraries",
        progress: downloaded / total,
        detail: lib.name,
      });
    }
    this.log(`Libraries download complete: ${downloaded}/${total}`);
  }

  async downloadAssets(versionData) {
    const assetIndex = versionData.assetIndex;
    if (!assetIndex?.url || !assetIndex?.id) {
      this.log(
        "No asset index found for this version, skipping assets download",
      );
      return;
    }

    const assetsDir = this.getAssetsDirectory();
    const indexesDir = path.join(assetsDir, "indexes");
    const objectsDir = path.join(assetsDir, "objects");
    const assetIndexPath = path.join(indexesDir, `${assetIndex.id}.json`);

    fs.ensureDirSync(indexesDir);
    fs.ensureDirSync(objectsDir);

    let assetIndexData;
    if (fs.existsSync(assetIndexPath)) {
      this.log(`Asset index already exists: ${assetIndexPath}`);
      assetIndexData = JSON.parse(fs.readFileSync(assetIndexPath, "utf-8"));
    } else {
      this.log(`Downloading asset index: ${assetIndex.url}`);
      await this.downloadFile(assetIndex.url, assetIndexPath);
      assetIndexData = JSON.parse(fs.readFileSync(assetIndexPath, "utf-8"));
    }

    const objects = Object.entries(assetIndexData.objects || {});
    let processed = 0;
    let downloaded = 0;
    const concurrency = 64;

    this.log(`Checking ${objects.length} assets...`);
    const missingAssets = objects.filter(([, asset]) => {
      if (!asset?.hash) {
        return false;
      }
      const hash = asset.hash;
      const hashPrefix = hash.substring(0, 2);
      const destPath = path.join(objectsDir, hashPrefix, hash);
      return !fs.existsSync(destPath);
    });

    processed = objects.length - missingAssets.length;
    this.log(`Missing assets: ${missingAssets.length}/${objects.length}`);
    this.log(`Downloading assets with concurrency ${concurrency}`);

    const updateProgress = () => {
      if (processed % 50 === 0 || processed === objects.length) {
        this.emit("progress", {
          task: "Downloading assets",
          progress: processed / objects.length,
          detail: `${processed}/${objects.length}`,
        });
      }
    };

    const processAsset = async (asset) => {
      const hash = asset.hash;
      const hashPrefix = hash.substring(0, 2);
      const destPath = path.join(objectsDir, hashPrefix, hash);
      const assetUrl = `https://resources.download.minecraft.net/${hashPrefix}/${hash}`;
      try {
        await this.downloadFile(assetUrl, destPath, null, {
          logStart: false,
          logComplete: false,
        });
        downloaded++;
      } catch (e) {
        this.log(`Failed to download asset ${hash}: ${e.message}`);
      }

      processed++;
      updateProgress();
    };

    updateProgress();

    for (let i = 0; i < missingAssets.length; i += concurrency) {
      const batch = missingAssets.slice(i, i + concurrency);
      await Promise.all(batch.map(([, asset]) => processAsset(asset)));
    }

    this.log(
      `Assets check complete: ${processed}/${objects.length}, downloaded ${downloaded}`,
    );
  }

  shouldDownloadLibrary(lib) {
    if (lib.rules) {
      let allowed = false;
      for (const rule of lib.rules) {
        if (!this.matchesRuleOS(rule.os)) {
          continue;
        }
        allowed = rule.action === "allow";
      }
      if (!allowed) {
        return false;
      }
    }
    return true;
  }

  getLibraryPath(lib) {
    if (lib.downloads?.artifact?.path) {
      return lib.downloads.artifact.path;
    }

    const classifierDownload = this.getNativeClassifierDownload(lib);
    if (classifierDownload?.path) {
      return classifierDownload.path;
    }

    const parts = lib.name.split(":");
    const group = parts[0].replace(/\./g, "/");
    const artifact = parts[1];
    const version = parts[2];
    const classifier = parts[3];

    if (classifier) {
      return `${group}/${artifact}/${version}/${artifact}-${version}-${classifier}.jar`;
    }

    return `${group}/${artifact}/${version}/${artifact}-${version}.jar`;
  }

  getLibraryUrl(lib) {
    if (lib.downloads?.artifact?.url) {
      return lib.downloads.artifact.url;
    }

    const classifierDownload = this.getNativeClassifierDownload(lib);
    if (classifierDownload?.url) {
      return classifierDownload.url;
    }

    const base = "https://libraries.minecraft.net";
    return `${base}/${this.getLibraryPath(lib).replace(/\\/g, "/")}`;
  }

  async downloadClientJar(versionData) {
    this.log(`Checking client JAR for ${versionData.id}`);
    const clientUrl = versionData.downloads.client.url;
    const versionDir = path.join(this.getVersionsDirectory(), versionData.id);
    const clientPath = path.join(versionDir, `${versionData.id}.jar`);

    if (fs.existsSync(clientPath)) {
      this.log(`Client JAR already exists: ${clientPath}`);
    } else {
      this.log(`Downloading client JAR from: ${clientUrl}`);
      this.emit("progress", {
        task: "Downloading Minecraft client",
        progress: 0,
      });
      await this.downloadFile(clientUrl, clientPath);
    }
  }

  async extractNatives(versionData) {
    const versionDir = path.join(this.getVersionsDirectory(), versionData.id);
    const nativesDir = path.join(versionDir, "natives");

    const nativeExtensions = process.platform === 'win32' ? ['.dll'] : process.platform === 'darwin' ? ['.dylib', '.jnilib'] : ['.so'];
    const hasRealNatives = (dir) => {
      if (!fs.existsSync(dir)) return false;
      const files = fs.readdirSync(dir);
      return files.some(f => nativeExtensions.some(ext => f.endsWith(ext)));
    };

    if (hasRealNatives(nativesDir)) {
      this.log(`Natives already extracted: ${nativesDir}`);
      this.log(`Natives files: ${fs.readdirSync(nativesDir).join(', ')}`);
      return nativesDir;
    }

    if (fs.existsSync(nativesDir)) {
      fs.removeSync(nativesDir);
    }

    this.log(`Extracting natives to: ${nativesDir}`);
    fs.ensureDirSync(nativesDir);

    const libs = versionData.libraries || [];
    let extractedCount = 0;

    for (const lib of libs) {
      if (!lib.downloads || !lib.downloads.classifiers) continue;

      const classifierDownload = this.getNativeClassifierDownload(lib);
      if (!classifierDownload) continue;

      let nativePath;
      if (classifierDownload.path) {
        nativePath = path.join(this.getLibrariesDirectory(), classifierDownload.path);
      } else {
        nativePath = path.join(this.getLibrariesDirectory(), this.getLibraryPath(lib));
      }
      this.log(`Extracting native: ${lib.name} from ${nativePath}`);

      if (fs.existsSync(nativePath)) {
        try {
          await this.extractZip(nativePath, nativesDir);
          extractedCount++;
        } catch (e) {
          this.log(`Failed to extract native: ${lib.name} - ${e.message}`);
        }
      } else {
        this.log(`Native file not found: ${nativePath}`);
      }
    }

    this.log(`Native extraction complete: ${extractedCount} JARs extracted`);
    this.log(`Natives directory contents: ${fs.readdirSync(nativesDir).join(', ')}`);

    return nativesDir;
  }

  async extractZip(zipPath, destDir) {
    const yauzl = require("yauzl");
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);

        zipfile.readEntry();
        zipfile.on("entry", (entry) => {
          if (entry.fileName.endsWith("/")) {
            zipfile.readEntry();
            return;
          }

          const safePath = entry.fileName.replace(/[^a-zA-Z0-9._\-/]/g, "_");
          const outputPath = path.join(destDir, safePath);
          fs.ensureDirSync(path.dirname(outputPath));

          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) {
              zipfile.readEntry();
              return;
            }

            const writeStream = fs.createWriteStream(outputPath);
            readStream.pipe(writeStream);
            writeStream.on("close", () => zipfile.readEntry());
          });
        });
        zipfile.on("end", resolve);
        zipfile.on("error", reject);
      });
    });
  }

  getLauncherProfiles(account) {
    return {
      authenticationDatabase: {
        [account.uuid]: {
          id: account.uuid,
          accessToken: account.accessToken,
          displayName: account.displayName,
          legacy: false,
          type: "msa",
          profileId: account.uuid,
          expiresAt: account.expiresAt,
          microsoft: account.microsoft,
        },
      },
      selectedProfile: account.uuid,
      version: 3,
    };
  }

  async launchVanilla(versionId, account, modpackId) {
    this._exitCode = null;
    const resolvedVersion = await this.resolveVersionId(versionId);
    this.log(`=== Starting launchVanilla for ${resolvedVersion} ===`);
    this.log(`Account: ${account.displayName} (${account.uuid})`);
    this.emit("launch", { versionId: resolvedVersion, account });

    const gameDir = this.prepareGameDirectory(modpackId);
    this.log(`Game directory (modpack): ${gameDir}`);

    const versionData = await this.ensureVersion(resolvedVersion);
    this.log(
      `Version data loaded: ${JSON.stringify(versionData).substring(0, 500)}...`,
    );

    await this.downloadLibraries(versionData);
    await this.downloadClientJar(versionData);
    await this.downloadAssets(versionData);

    this.emit("progress", { task: "Extracting natives", progress: 0 });
    const nativesDir = await this.extractNatives(versionData);
    this.log(`Natives dir: ${nativesDir}`);

    this.emit("progress", { task: "Preparing game", progress: 0 });

    const launcherProfiles = this.getLauncherProfiles(account);
    const profilesPath = path.join(gameDir, "launcher_profiles.json");
    this.log(`Writing launcher_profiles.json to: ${profilesPath}`);
    fs.ensureDirSync(gameDir);
    fs.writeFileSync(profilesPath, JSON.stringify(launcherProfiles, null, 4));

    const assetsDir = this.getAssetsDirectory();
    const versionDir = path.join(this.getVersionsDirectory(), resolvedVersion);
    const clientJar = path.join(versionDir, `${resolvedVersion}.jar`);

    this.log(`Game directory: ${gameDir}`);
    this.log(`Client JAR: ${clientJar}`);

    const classPath = await this.buildClassPath(versionData);
    this.log(`ClassPath: ${classPath.substring(0, 500)}...`);

    const jvmArgs = this.buildJvmArguments(versionData, {
      nativesPath: nativesDir,
      classPath,
      gameDir,
    });

    this.log(`JVM Args: ${JSON.stringify(jvmArgs)}`);

    const gameArgs = this.buildGameArguments(versionData, {
      gameDir,
      assetsDir,
      nativesPath: nativesDir,
      versionDir,
      account,
    });

    this.log(`Game Args: ${JSON.stringify(gameArgs)}`);

    const javaExe = this.findJava();
    this.log(`Java executable: ${javaExe}`);

    const fullCommand = [javaExe, ...jvmArgs, ...gameArgs];
    this.log(`Full command: ${fullCommand.join(" ")}`);

    this.emit("progress", { task: "Launching Minecraft", progress: 1 });

    this.proc = spawn(javaExe, [...jvmArgs, ...gameArgs], {
      cwd: gameDir,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this._gameRunning = true;
    this._attachGameLogs(modpackId);

    this.proc.unref();

    this.log(`=== Game launched! (PID: ${this.proc.pid}) ===`);

    await new Promise((r) => setTimeout(r, 2000));

    return true;
  }

  async launchFabric(versionId, account, modpackId) {
    this._exitCode = null;
    const resolvedVersion = await this.resolveVersionId(versionId);
    this.log(`=== Starting launchFabric for ${resolvedVersion} ===`);
    this.log(`Account: ${account.displayName} (${account.uuid})`);
    this.emit("launch", { versionId: resolvedVersion, account });

    const gameDir = this.prepareGameDirectory(modpackId);
    this.log(`Game directory (modpack): ${gameDir}`);

    const versionData = await this.ensureVersion(resolvedVersion);
    this.log(`Vanilla version data loaded for ${resolvedVersion}`);

    this.emit("progress", { task: "Fetching Fabric loader info", progress: 0 });

    let loaderInfo;
    try {
      // Fetch the highest available loader version for the Minecraft version
      const loaderVersions = await this.fetchJson(
        `${FABRIC_META}/versions/loader/${resolvedVersion}`,
      );
      if (!loaderVersions || loaderVersions.length === 0) {
        throw new Error(`No Fabric loader found for version ${resolvedVersion}`);
      }
      loaderInfo = loaderVersions[0];
      this.log(`Fabric loader: ${loaderInfo.loader.version}`);
    } catch (e) {
      this.log(`Failed to fetch Fabric loader: ${e.message}`);
      throw new Error(
        `Fabric loader not available for ${resolvedVersion}: ${e.message}`,
      );
    }

    // Safely extract the main class from launcherMeta (or fallback to modern Fabric's default)
    const mainClass =
      loaderInfo.launcherMeta?.mainClass?.client ||
      (loaderInfo.launcherMeta?.mainClass &&
      typeof loaderInfo.launcherMeta.mainClass === "string"
        ? loaderInfo.launcherMeta.mainClass
        : null) ||
      "net.fabricmc.loader.impl.launch.knot.KnotClient";

    this.log(`Fabric mainClass: ${mainClass}`);

    this.emit("progress", {
      task: "Downloading Fabric libraries",
      progress: 0.1,
    });

    // Extract all libraries directly from the first API response
    const fabricLibs = [];

    // 1. Intermediary mappings
    if (loaderInfo.intermediary) {
      fabricLibs.push({
        name: loaderInfo.intermediary.maven,
        url: "https://maven.fabricmc.net/",
      });
    }

    // 2. Fabric Loader core jar
    if (loaderInfo.loader) {
      fabricLibs.push({
        name: loaderInfo.loader.maven,
        url: "https://maven.fabricmc.net/",
      });
    }

    // 3. Common and Client dependencies
    if (loaderInfo.launcherMeta?.libraries) {
      const processLib = (lib) => {
        if (typeof lib === "string") {
          fabricLibs.push({ name: lib, url: "https://maven.fabricmc.net/" });
        } else if (lib && lib.name) {
          fabricLibs.push({
            name: lib.name,
            url: lib.url || "https://maven.fabricmc.net/",
          });
        }
      };
      if (loaderInfo.launcherMeta.libraries.common)
        loaderInfo.launcherMeta.libraries.common.forEach(processLib);
      if (loaderInfo.launcherMeta.libraries.client)
        loaderInfo.launcherMeta.libraries.client.forEach(processLib);
    }

    this.log(`Total Fabric libraries to process: ${fabricLibs.length}`);

    // Download all Fabric libraries
    let downloaded = 0;
    const totalLibs = fabricLibs.length;
    for (const lib of fabricLibs) {
      let url = lib.url || "https://maven.fabricmc.net/";
      const libPath = this.getFabricLibraryPath(lib);
      const dest = path.join(this.getLibrariesDirectory(), libPath);

      // CRITICAL FIX: Make sure the base URL gets the full jar path appended properly
      if (!url.endsWith(".jar")) {
        url = url.endsWith("/")
          ? url + libPath.replace(/\\/g, "/")
          : url + "/" + libPath.replace(/\\/g, "/");
      }

      if (fs.existsSync(dest)) {
        this.log(`Fabric library exists: ${lib.name || libPath}`);
      } else {
        try {
          await this.downloadFile(url, dest);
        } catch (e) {
          this.log(
            `Failed to download Fabric library: ${lib.name || libPath} - ${e.message}`,
          );
        }
      }

      downloaded++;
      this.emit("progress", {
        task: "Downloading Fabric libraries",
        progress: downloaded / totalLibs,
        detail: lib.name || libPath,
      });
    }

    // Download vanilla files
    this.emit("progress", { task: "Downloading vanilla files", progress: 0 });
    await this.downloadLibraries(versionData);
    await this.downloadClientJar(versionData);
    await this.downloadAssets(versionData);

    // Extract natives
    this.emit("progress", { task: "Extracting natives", progress: 0 });
    const nativesDir = await this.extractNatives(versionData);

    this.emit("progress", { task: "Preparing game", progress: 0 });

    // Write launcher_profiles.json
    const launcherProfiles = this.getLauncherProfiles(account);
    const profilesPath = path.join(gameDir, "launcher_profiles.json");
    fs.ensureDirSync(gameDir);
    fs.writeFileSync(profilesPath, JSON.stringify(launcherProfiles, null, 4));

    const assetsDir = this.getAssetsDirectory();

    // Build classpath: vanilla client jar + vanilla libs + Fabric libs
    const classPath = await this.buildFabricClassPath(versionData, fabricLibs);
    this.log(
      `Fabric classpath built (${classPath.split(process.platform === "win32" ? ";" : ":").length} entries)`,
    );

    // Build JVM args from vanilla version data
    const fabricVersionData = {
      ...versionData,
      mainClass: mainClass,
    };

    const jvmArgs = this.buildJvmArguments(fabricVersionData, {
      nativesPath: nativesDir,
      classPath,
      gameDir,
    });

    // Inject Fabric-specific JVM arguments if present in the metadata
    if (loaderInfo.launcherMeta?.arguments?.jvm) {
      const fabricJvmArgs = loaderInfo.launcherMeta.arguments.jvm;
      for (const arg of fabricJvmArgs) {
        if (typeof arg === "string") {
          this.log(`Adding Fabric JVM arg: ${arg}`);
          jvmArgs.splice(jvmArgs.length - 3, 0, arg);
        } else if (arg.rules && arg.value) {
          if (this.checkRule(arg.rules, "allow")) {
            const values = this.getArgumentValues(arg.value);
            for (const val of values) {
              if (typeof val === "string") {
                this.log(`Adding Fabric JVM arg (rule): ${val}`);
                jvmArgs.splice(jvmArgs.length - 3, 0, val);
              }
            }
          }
        }
      }
    }

    const hasNativeLibPath = jvmArgs.some(a => typeof a === 'string' && a.includes('java.library.path'));
    if (!hasNativeLibPath) {
      jvmArgs.splice(jvmArgs.length - 3, 0, `-Djava.library.path=${nativesDir}`);
    }

    this.log(`Final JVM Args: ${JSON.stringify(jvmArgs)}`);

    // Build game args from vanilla version data
    const gameArgs = this.buildGameArguments(versionData, {
      gameDir,
      assetsDir,
      nativesPath: nativesDir,
      versionDir: path.join(this.getVersionsDirectory(), resolvedVersion),
      account,
    });

    this.log(`Game Args: ${JSON.stringify(gameArgs)}`);
    this.log(`Main class: ${mainClass}`);

    const javaExe = this.findJava();

    this.emit("progress", {
      task: "Launching Minecraft with Fabric",
      progress: 1,
    });

    this.proc = spawn(javaExe, [...jvmArgs, ...gameArgs], {
      cwd: gameDir,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this._gameRunning = true;
    this._attachGameLogs(modpackId);

    this.proc.unref();

    this.log(`=== Game launched with Fabric! (PID: ${this.proc.pid}) ===`);

    await new Promise((r) => setTimeout(r, 2000));

    return true;
  }

  getFabricLibraryPath(lib) {
    // Prefer URL-based path since it's the actual download location
    // (names may miss classifiers like -v2, -natives, etc.)
    if (lib.url) {
      try {
        const urlObj = new URL(lib.url);
        const urlPath = urlObj.pathname.startsWith("/")
          ? urlObj.pathname.substring(1)
          : urlObj.pathname;
        if (urlPath && urlPath.endsWith(".jar")) {
          return urlPath;
        }
      } catch (e) {}
    }
    // Fallback: derive from Maven coordinate name
    if (lib.name) {
      const parts = lib.name.split(":");
      if (parts.length >= 3) {
        const group = parts[0].replace(/\./g, "/");
        const artifact = parts[1];
        const version = parts[2];
        const classifier = parts[3];
        if (classifier) {
          return `${group}/${artifact}/${version}/${artifact}-${version}-${classifier}.jar`;
        }
        return `${group}/${artifact}/${version}/${artifact}-${version}.jar`;
      }
    }
    return `unknown/${Date.now()}.jar`;
  }

  async buildFabricClassPath(versionData, fabricLibs) {
    const classPath = [];
    const seenArtifacts = new Set();

    const versionDir = path.join(this.getVersionsDirectory(), versionData.id);
    const clientJar = path.join(versionDir, `${versionData.id}.jar`);
    classPath.push(clientJar);

    const extractArtifactKey = (libPath) => {
      const normalized = libPath.replace(/\\/g, '/');
      const parts = normalized.split('/');
      if (parts.length >= 4) {
        const group = parts.slice(0, -3).join('/');
        const artifact = parts[parts.length - 3];
        const version = parts[parts.length - 2];
        const filename = parts[parts.length - 1];
        const baseName = `${artifact}-${version}`;
        if (filename.startsWith(baseName + '-') && filename.endsWith('.jar')) {
          const classifier = filename.slice(baseName.length + 1, -4);
          return `${group}:${artifact}:${classifier}`;
        }
        return `${group}:${artifact}`;
      }
      return normalized;
    };

    const allLibs = [...(versionData.libraries || [])];
    for (const lib of allLibs) {
      if (!this.shouldDownloadLibrary(lib)) continue;
      const libPath = path.join(
        this.getLibrariesDirectory(),
        this.getLibraryPath(lib),
      );
      if (fs.existsSync(libPath)) {
        const key = extractArtifactKey(libPath);
        if (!seenArtifacts.has(key)) {
          seenArtifacts.add(key);
          classPath.push(libPath);
        }
      }
    }

    for (const lib of fabricLibs) {
      const libPath = path.join(
        this.getLibrariesDirectory(),
        this.getFabricLibraryPath(lib),
      );
      if (fs.existsSync(libPath)) {
        const key = extractArtifactKey(libPath);
        if (!seenArtifacts.has(key)) {
          seenArtifacts.add(key);
          classPath.push(libPath);
        } else {
          const idx = classPath.findIndex(p => extractArtifactKey(p) === key);
          if (idx !== -1) {
            classPath[idx] = libPath;
          }
        }
      }
    }

    return classPath.join(process.platform === "win32" ? ";" : ":");
  }

  buildGameArguments(versionData, opts) {
    const { gameDir, assetsDir, versionDir, account } = opts;

    const args = [];
    const argData = versionData.arguments || {};
    const gameArgsList = argData.game || [];
    const features = {
      is_demo_user: false,
      has_custom_resolution: true,
      has_quick_plays_support: false,
      is_quick_play_singleplayer: false,
      is_quick_play_multiplayer: false,
      is_quick_play_realms: false,
    };

    // Fallback for older versions
    if (gameArgsList.length === 0 && versionData.minecraftArguments) {
      const legacyArgs = versionData.minecraftArguments.split(" ");
      for (const arg of legacyArgs) {
        args.push(
          arg
            .replace("${auth_access_token}", account.accessToken)
            .replace("${auth_player_name}", account.displayName)
            .replace("${auth_uuid}", account.uuid)
            .replace("${auth_session}", account.accessToken)
            .replace("${version_name}", versionData.id)
            .replace("${game_directory}", gameDir)
            .replace("${assets_root}", assetsDir)
            .replace(
              "${assets_index_name}",
              versionData.assetIndex?.id || versionData.id,
            )
            .replace("${user_type}", "MSA")
            .replace("${version_type}", versionData.type || "release"),
        );
      }
      args.push("--width", "854");
      args.push("--height", "480");
      return args;
    }

    for (const arg of gameArgsList) {
      if (typeof arg === "string") {
        args.push(
          arg
            .replace("${auth_access_token}", account.accessToken)
            .replace("${auth_player_name}", account.displayName)
            .replace("${auth_uuid}", account.uuid)
            .replace("${auth_session}", account.accessToken)
            .replace("${version_name}", versionData.id)
            .replace("${game_directory}", gameDir)
            .replace("${assets_root}", assetsDir)
            .replace(
              "${assets_index_name}",
              versionData.assetIndex?.id || versionData.id,
            )
            .replace("${user_type}", "MSA")
            .replace("${version_type}", versionData.type || "release"),
        );
      } else if (arg.rules && arg.value) {
        if (this.checkRule(arg.rules, "allow", features)) {
          for (const val of this.getArgumentValues(arg.value)) {
            if (typeof val === "string") {
              args.push(
                val
                  .replace("${auth_access_token}", account.accessToken)
                  .replace("${auth_player_name}", account.displayName)
                  .replace("${auth_uuid}", account.uuid)
                  .replace("${auth_session}", account.accessToken)
                  .replace("${version_name}", versionData.id)
                  .replace("${game_directory}", gameDir)
                  .replace("${assets_root}", assetsDir)
                  .replace(
                    "${assets_index_name}",
                    versionData.assetIndex?.id || versionData.id,
                  )
                  .replace("${user_type}", "MSA")
                  .replace("${version_type}", versionData.type || "release"),
              );
            }
          }
        }
      }
    }

    args.push("--width", "854");
    args.push("--height", "480");

    return args;
  }

  buildJvmArguments(versionData, opts) {
    const { nativesPath, classPath, gameDir } = opts;

    const args = [];
    const argData = versionData.arguments || {};
    const jvmArgs = argData.jvm || [];

    const maxMem = 2048;
    const minMem = 512;

    args.push(`-Xmx${maxMem}M`);
    args.push(`-Xms${minMem}M`);
    let hasExplicitClasspath = false;

    for (const arg of jvmArgs) {
      if (typeof arg === "string") {
        const resolvedArg = this.resolveJvmPlaceholder(arg, versionData, {
          nativesPath,
          classPath,
          gameDir,
        });
        hasExplicitClasspath =
          hasExplicitClasspath ||
          resolvedArg === "-cp" ||
          resolvedArg === "-classpath";
        args.push(resolvedArg);
      } else if (arg.rules && arg.value) {
        if (this.checkRule(arg.rules, "allow")) {
          for (const val of this.getArgumentValues(arg.value)) {
            if (typeof val === "string") {
              const resolvedArg = this.resolveJvmPlaceholder(val, versionData, {
                nativesPath,
                classPath,
                gameDir,
              });
              hasExplicitClasspath =
                hasExplicitClasspath ||
                resolvedArg === "-cp" ||
                resolvedArg === "-classpath";
              args.push(resolvedArg);
            }
          }
        }
      }
    }

    if (!hasExplicitClasspath) {
      args.push("-cp");
      args.push(classPath);
    }
    args.push(versionData.mainClass);

    this.log(
      `JVM command: java ${args.slice(0, 5).join(" ")} ... ${versionData.mainClass}`,
    );

    return args;
  }

  checkRule(rules, action, features = {}) {
    let matched = false;
    for (const rule of rules) {
      if (!this.matchesRule(rule, features)) {
        continue;
      }
      matched = rule.action === action;
    }
    return matched;
  }

  matchesRule(rule, features = {}) {
    if (!this.matchesRuleOS(rule.os)) {
      return false;
    }

    if (rule.features) {
      for (const [featureName, expectedValue] of Object.entries(
        rule.features,
      )) {
        if ((features[featureName] ?? false) !== expectedValue) {
          return false;
        }
      }
    }

    return true;
  }

  getArgumentValues(value) {
    return Array.isArray(value) ? value : [value];
  }

  getMinecraftOSName() {
    if (process.platform === "win32") return "windows";
    if (process.platform === "darwin") return "osx";
    if (process.platform === "linux") return "linux";
    return process.platform;
  }

  matchesRuleOS(ruleOS) {
    if (!ruleOS) {
      return true;
    }

    if (ruleOS.name && ruleOS.name !== this.getMinecraftOSName()) {
      return false;
    }

    if (ruleOS.arch && ruleOS.arch !== process.arch) {
      return false;
    }

    return true;
  }

  getNativeClassifierKey() {
    const osName = this.getMinecraftOSName();
    if (osName === "windows") {
      return process.arch === "x64" ? "natives-windows" : "natives-windows-32";
    }
    if (osName === "osx") {
      return process.arch === "arm64" ? "natives-macos-arm64" : "natives-macos";
    }
    if (osName === "linux") {
      if (process.arch === "arm64") return "natives-linux-arm64";
      return "natives-linux";
    }
    return null;
  }

  getNativeClassifierDownload(lib) {
    const classifiers = lib.downloads?.classifiers;
    if (!classifiers) {
      return null;
    }

    const preferredKeys = [
      this.getNativeClassifierKey(),
      "natives-windows",
      "natives-macos",
      "natives-linux",
    ].filter(Boolean);
    for (const key of preferredKeys) {
      if (classifiers[key]) {
        return classifiers[key];
      }
    }

    return null;
  }

  resolveJvmPlaceholder(arg, versionData, opts) {
    const { nativesPath, classPath, gameDir } = opts;
    return arg
      .replace("${natives_directory}", nativesPath)
      .replace("${classpath}", classPath)
      .replace("${game_directory}", gameDir)
      .replace("${launcher_name}", "CosmicLauncher")
      .replace("${launcher_version}", versionData?.launcherVersion || "dev");
  }

  async buildClassPath(versionData) {
    const classPath = [];

    const versionDir = path.join(this.getVersionsDirectory(), versionData.id);
    const clientJar = path.join(versionDir, `${versionData.id}.jar`);
    classPath.push(clientJar);

    const libs = versionData.libraries || [];
    for (const lib of libs) {
      if (!this.shouldDownloadLibrary(lib)) continue;
      const libPath = path.join(
        this.getLibrariesDirectory(),
        this.getLibraryPath(lib),
      );
      if (fs.existsSync(libPath)) {
        classPath.push(libPath);
      }
    }

    return classPath.join(process.platform === "win32" ? ";" : ":");
  }

  findJava() {
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
      const javaExe = path.join(
        javaHome,
        "bin",
        "java" + (process.platform === "windows" ? ".exe" : ""),
      );
      this.log(`Using JAVA_HOME: ${javaExe}`);
      return javaExe;
    }

    if (process.platform === "win32") {
      const programFiles = [
        process.env["ProgramFiles"],
        process.env["ProgramFiles(x86)"],
      ].filter(Boolean);

      for (const pf of programFiles) {
        const javaPath = path.join(pf, "Java", "jre8", "bin", "java.exe");
        if (fs.existsSync(javaPath)) return javaPath;

        const javaPath2 = path.join(pf, "Java", "bin", "java.exe");
        if (fs.existsSync(javaPath2)) return javaPath2;
      }
    }

    this.log("Using system java command");
    return "java";
  }

  _startPlaySession(modpackId, proc) {
    if (!modpackId || !proc || !proc.pid) return;
    this._playSessions.set(proc.pid, {
      modpackId,
      startedAt: Date.now(),
      flushedMs: 0,
    });
    this._ensurePlayFlushTimer();
    this._emitPlayTime();
  }

  _ensurePlayFlushTimer() {
    if (this._playFlushTimer) return;
    this._playTick = 0;
    this._playFlushTimer = setInterval(() => {
      this._playTick += 1;
      if (this._playTick % 15 === 0) this.flushPlayTime();
      this._emitPlayTime();
      if (this._playSessions.size === 0) {
        clearInterval(this._playFlushTimer);
        this._playFlushTimer = null;
      }
    }, 1000);
  }

  _livePlaySnapshots() {
    const extras = new Map();
    for (const session of this._playSessions.values()) {
      const elapsed = Math.max(0, Date.now() - session.startedAt);
      const unflushed = Math.max(0, elapsed - session.flushedMs);
      extras.set(session.modpackId, (extras.get(session.modpackId) || 0) + unflushed);
    }
    const updates = [];
    for (const [modpackId, extra] of extras) {
      const pack = ModpackManager.getById(modpackId);
      updates.push({
        modpackId,
        playTimeMs: (pack?.playTimeMs || 0) + extra,
        lastPlayedAt: pack?.lastPlayedAt || Date.now(),
      });
    }
    return updates;
  }

  _emitPlayTime() {
    const updates = this._livePlaySnapshots();
    if (updates.length) this.emit("playTime", { updates });
  }

  flushPlayTime() {
    let saved = false;
    for (const session of this._playSessions.values()) {
      const elapsed = Math.max(0, Date.now() - session.startedAt);
      const delta = elapsed - session.flushedMs;
      if (delta < 500) continue;
      ModpackManager.addPlayTime(session.modpackId, delta);
      session.flushedMs = elapsed;
      saved = true;
    }
    if (saved) this._emitPlayTime();
    return saved;
  }

  _endPlaySession(pid) {
    const session = this._playSessions.get(pid);
    if (!session) return null;
    const elapsed = Math.max(0, Date.now() - session.startedAt);
    const delta = elapsed - session.flushedMs;
    if (delta > 0) ModpackManager.addPlayTime(session.modpackId, delta);
    this._playSessions.delete(pid);
    const pack = ModpackManager.getById(session.modpackId);
    this.emit("playTime", {
      updates: [{
        modpackId: session.modpackId,
        playTimeMs: pack?.playTimeMs || 0,
        lastPlayedAt: pack?.lastPlayedAt || Date.now(),
      }],
    });
    if (this._playSessions.size === 0 && this._playFlushTimer) {
      clearInterval(this._playFlushTimer);
      this._playFlushTimer = null;
    }
    return pack;
  }

  endAllPlaySessions() {
    const pids = [...this._playSessions.keys()];
    for (const pid of pids) this._endPlaySession(pid);
  }

  _attachGameLogs(modpackId) {
    if (!this.proc) return;

    const proc = this.proc;
    const pid = proc.pid;
    this._startPlaySession(modpackId, proc);

    const sendLine = (line) => {
      this.emit("gameLog", line);
    };

    if (proc.stdout) {
      let buf = "";
      proc.stdout.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (line.trim()) sendLine(line.trimEnd());
        }
      });
      proc.stdout.on("end", () => {
        if (buf.trim()) sendLine(buf.trimEnd());
      });
    }

    if (proc.stderr) {
      let buf = "";
      proc.stderr.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (line.trim()) sendLine(line.trimEnd());
        }
      });
      proc.stderr.on("end", () => {
        if (buf.trim()) sendLine(buf.trimEnd());
      });
    }

    proc.on("exit", (code, signal) => {
      this._endPlaySession(pid);
      if (this.proc === proc) {
        this._gameRunning = this._playSessions.size > 0;
        this.proc = null;
      }
      this.emit("gameLog", `=== Game exited (code: ${code}, signal: ${signal}) ===`);
      this.emit("gameExit", { code, signal });
    });

    proc.on("error", (err) => {
      this._endPlaySession(pid);
      if (this.proc === proc) {
        this._gameRunning = this._playSessions.size > 0;
        this.proc = null;
      }
      this.emit("gameLog", `=== Game process error: ${err.message} ===`);
      this.emit("gameExit", { code: null, signal: "error" });
    });
  }

  on(event, callback) {
    if (event === "progress") {
      this._progressCallback = callback;
    } else if (event === "launch") {
      this._launchCallback = callback;
    } else if (event === "log") {
      this._logCallback = callback;
    } else if (event === "gameLog") {
      this._gameLogCallback = callback;
    } else if (event === "gameExit") {
      this._gameExitCallback = callback;
    } else if (event === "playTime") {
      this._playTimeCallback = callback;
    }
  }

  emit(event, data) {
    if (event === "progress" && this._progressCallback) {
      this._progressCallback(data);
    } else if (event === "launch" && this._launchCallback) {
      this._launchCallback(data);
    } else if (event === "log" && this._logCallback) {
      this._logCallback(data);
    } else if (event === "gameLog" && this._gameLogCallback) {
      this._gameLogCallback(data);
    } else if (event === "gameExit" && this._gameExitCallback) {
      this._gameExitCallback(data);
    } else if (event === "playTime" && this._playTimeCallback) {
      this._playTimeCallback(data);
    }
  }
}

module.exports = new LaunchManager()
