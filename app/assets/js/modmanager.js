const https = require('https');
const fs = require('fs-extra');
const path = require('path');
const ConfigManager = require('./configmanager');

const MODRINTH_API = 'https://api.modrinth.com/v2';

class ModManager {
  constructor() {
    this._modDatabase = {};
    this._dirty = false;
  }

  getMinecraftModsDirectory() {
    const minecraftDir = path.join(
      ConfigManager.getLauncherDirectory(),
      'minecraft',
      'mods'
    );
    return minecraftDir;
  }

  getModsDatabasePath() {
    return path.join(ConfigManager.getLauncherDirectory(), 'mods-database.json');
  }

  _ensureModsDir() {
    fs.ensureDirSync(this.getMinecraftModsDirectory());
  }

  _loadDatabase() {
    const dbPath = this.getModsDatabasePath();
    if (fs.existsSync(dbPath)) {
      try {
        this._modDatabase = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
      } catch (e) {
        console.error('Error loading mod database:', e);
        this._modDatabase = {};
      }
    }
  }

  _saveDatabase() {
    if (!this._dirty) return;
    fs.ensureDirSync(path.dirname(this.getModsDatabasePath()));
    fs.writeFileSync(this.getModsDatabasePath(), JSON.stringify(this._modDatabase, null, 2), 'utf-8');
    this._dirty = false;
  }

  getInstalledMods() {
    this._loadDatabase();
    return { ...this._modDatabase };
  }

  async searchMods(query, gameVersions = [], loaders = ['fabric']) {
    const params = new URLSearchParams();
    params.set('query', query);
    params.set('limit', '30');
    params.set('facets', JSON.stringify([
      ['project_type:mod'],
      loaders.map(l => `categories:${l}`),
    ]));

    const data = await this._fetchJson(`${MODRINTH_API}/search?${params}`);
    return data.hits || [];
  }

  async getProject(projectId) {
    return this._fetchJson(`${MODRINTH_API}/project/${projectId}`);
  }

  async getProjectVersions(projectId, gameVersions = [], loaders = ['fabric']) {
    const params = new URLSearchParams();
    if (gameVersions.length) params.set('game_versions', JSON.stringify(gameVersions));
    if (loaders.length) params.set('loaders', JSON.stringify(loaders));
    const qs = params.toString();
    return this._fetchJson(`${MODRINTH_API}/project/${projectId}/version${qs ? '?' + qs : ''}`);
  }

  async installMod(projectId, versionId, gameVersion, loader) {
    this._loadDatabase();
    this._ensureModsDir();

    const project = await this.getProject(projectId);
    const versions = await this._fetchJson(`${MODRINTH_API}/project/${projectId}/version`);
    const targetVersion = versionId
      ? versions.find(v => v.id === versionId)
      : versions.find(v =>
          v.game_versions.includes(gameVersion) &&
          v.loaders.includes(loader)
        );

    if (!targetVersion) {
      throw new Error(`No compatible version found for ${project.title} on ${gameVersion} ${loader}`);
    }

    const primaryFile = targetVersion.files.find(f => f.primary) || targetVersion.files[0];
    if (!primaryFile) throw new Error('No downloadable file found');

    const destPath = path.join(this.getMinecraftModsDirectory(), primaryFile.filename);

    if (fs.existsSync(destPath)) {
      throw new Error(`Mod file already exists: ${primaryFile.filename}`);
    }

    await this._downloadFile(primaryFile.url, destPath);

    this._modDatabase[projectId] = {
      projectId,
      slug: project.slug,
      title: project.title,
      description: project.description,
      icon_url: project.icon_url,
      client_side: project.client_side,
      installedVersion: targetVersion.id,
      versionNumber: targetVersion.version_number,
      filename: primaryFile.filename,
      filePath: destPath,
      gameVersions: targetVersion.game_versions,
      loaders: targetVersion.loaders,
      enabled: true,
      installedAt: Date.now(),
    };

    this._dirty = true;
    this._saveDatabase();

    return this._modDatabase[projectId];
  }

  removeMod(projectId) {
    this._loadDatabase();
    const mod = this._modDatabase[projectId];
    if (!mod) throw new Error('Mod not found in database');

    if (fs.existsSync(mod.filePath)) {
      try { fs.unlinkSync(mod.filePath); } catch (e) {
        console.error(`Failed to delete mod file: ${mod.filePath}`, e);
      }
    }

    const disabledPath = mod.filePath.replace(/\.jar$/i, '.jar.disabled');
    if (fs.existsSync(disabledPath)) {
      try { fs.unlinkSync(disabledPath); } catch (e) {} 
    }

    delete this._modDatabase[projectId];
    this._dirty = true;
    this._saveDatabase();
  }

  setModEnabled(projectId, enabled) {
    this._loadDatabase();
    if (this._modDatabase[projectId]) {
      this._modDatabase[projectId].enabled = enabled;
      this._dirty = true;
      this._saveDatabase();

      const mod = this._modDatabase[projectId];
      const jarPath = mod.filePath;
      const disabledPath = jarPath.replace(/\.jar$/i, '.jar.disabled');

      if (enabled) {
        if (fs.existsSync(disabledPath)) {
          fs.renameSync(disabledPath, jarPath);
        }
      } else {
        if (fs.existsSync(jarPath)) {
          fs.renameSync(jarPath, disabledPath);
        }
      }
    }
  }

  getModsForClasspath() {
    this._loadDatabase();
    const active = [];
    for (const [id, mod] of Object.entries(this._modDatabase)) {
      if (mod.enabled && fs.existsSync(mod.filePath)) {
        active.push(mod.filePath);
      }
    }
    return active;
  }

  syncModsForVersion(gameVersion, loader) {
    this._loadDatabase();
    let changed = false;

    for (const [id, mod] of Object.entries(this._modDatabase)) {
      const isCompatible = mod.gameVersions.includes(gameVersion) && mod.loaders.includes(loader);
      const shouldBeEnabled = isCompatible;

      if (mod.enabled !== shouldBeEnabled) {
        this.setModEnabled(id, shouldBeEnabled);
        changed = true;
      }
    }

    return changed;
  }

  async _fetchJson(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        });
      }).on('error', reject);
    });
  }

  async _downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
      fs.ensureDirSync(path.dirname(destPath));
      const file = fs.createWriteStream(destPath);
      https.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(destPath);
          this._downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
          return;
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', (err) => {
        file.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        reject(err);
      });
    });
  }
}

module.exports = new ModManager();
