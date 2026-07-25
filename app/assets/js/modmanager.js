const https = require('https');
const fs = require('fs-extra');
const path = require('path');
const yauzl = require('yauzl');
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

  async removeMod(projectId) {
    this._loadDatabase();
    const mod = this._modDatabase[projectId];
    if (!mod) throw new Error('Mod not found in database');

    if (fs.existsSync(mod.filePath)) {
      try {
        await this._safeUnlink(mod.filePath);
      } catch (e) {
        console.error(`Failed to delete mod file: ${mod.filePath}`, e);
        throw e;
      }
    }

    const disabledPath = mod.filePath.replace(/\.jar$/i, '.jar.disabled');
    if (fs.existsSync(disabledPath)) {
      try { await this._safeUnlink(disabledPath); } catch (e) {}
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

      try {
        if (enabled) {
          if (fs.existsSync(disabledPath)) {
            fs.renameSync(disabledPath, jarPath);
          }
        } else if (fs.existsSync(jarPath)) {
          fs.renameSync(jarPath, disabledPath);
        }
      } catch (e) {
        this._modDatabase[projectId].enabled = !enabled;
        this._dirty = true;
        this._saveDatabase();
        throw this._fileError(e, jarPath);
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

  _pickLatestVersion(versions) {
    if (!Array.isArray(versions) || versions.length === 0) return null;
    return [...versions].sort((a, b) => {
      const dateA = new Date(a.date_published || 0).getTime();
      const dateB = new Date(b.date_published || 0).getTime();
      if (dateB !== dateA) return dateB - dateA;
      return this._versionCompare(b.version_number, a.version_number);
    })[0];
  }

  async _getVersion(versionId) {
    if (!versionId) return null;
    if (!this._versionCache) this._versionCache = new Map();
    if (this._versionCache.has(versionId)) return this._versionCache.get(versionId);
    try {
      const version = await this._fetchJson(`${MODRINTH_API}/version/${versionId}`);
      this._versionCache.set(versionId, version);
      return version;
    } catch (e) {
      console.error(`Failed to fetch version ${versionId}:`, e.message);
      return null;
    }
  }

  _clearVersionCache() {
    this._versionCache = new Map();
  }

  _dependencyTargetsInstalled(dep, installed) {
    if (!dep?.project_id || !installed) return false;
    if (dep.version_id) return installed.installedVersion === dep.version_id;
    return true;
  }

  _dependencyTargetsVersion(dep, versionData) {
    if (!dep?.project_id || !versionData) return false;
    if (dep.version_id) return versionData.id === dep.version_id;
    return versionData.project_id === dep.project_id;
  }

  async _versionConflictsWithInstalled(versionData) {
    this._loadDatabase();
    if (!versionData) return [];

    const conflicts = [];
    const seen = new Set();
    const candidateProjectId = versionData.project_id;

    const addConflict = (installed, reason) => {
      const key = `${candidateProjectId}:${installed.projectId}`;
      if (seen.has(key)) return;
      seen.add(key);
      conflicts.push({
        projectId: installed.projectId,
        title: installed.title,
        reason,
      });
    };

    for (const dep of versionData.dependencies || []) {
      if (dep.dependency_type !== 'incompatible' || !dep.project_id) continue;
      const installed = this._modDatabase[dep.project_id];
      if (!installed?.enabled) continue;
      if (this._dependencyTargetsInstalled(dep, installed)) {
        addConflict(
          installed,
          `${versionData.name || versionData.version_number} is incompatible with ${installed.title}`
        );
      }
    }

    for (const installed of Object.values(this._modDatabase)) {
      if (!installed.enabled || installed.projectId === candidateProjectId) continue;
      const installedVersion = await this._getVersion(installed.installedVersion);
      if (!installedVersion) continue;

      for (const dep of installedVersion.dependencies || []) {
        if (dep.dependency_type !== 'incompatible') continue;
        if (dep.project_id !== candidateProjectId) continue;
        if (this._dependencyTargetsVersion(dep, versionData)) {
          addConflict(
            installed,
            `${installed.title} ${installed.versionNumber} is incompatible with this version`
          );
        }
      }
    }

    return conflicts;
  }

  async _getBestCompatibleVersion(projectId, gameVersion, loader, beforeDate) {
    try {
      const params = new URLSearchParams();
      params.set('game_versions', JSON.stringify([gameVersion]));
      params.set('loaders', JSON.stringify([loader]));
      let versions = await this._fetchJson(`${MODRINTH_API}/project/${projectId}/version?${params}`);
      if (!Array.isArray(versions) || versions.length === 0) return null;

      if (beforeDate) {
        versions = versions.filter(v => v.date_published < beforeDate);
        if (versions.length === 0) return null;
      }

      versions = [...versions].sort((a, b) => {
        const dateA = new Date(a.date_published || 0).getTime();
        const dateB = new Date(b.date_published || 0).getTime();
        if (dateB !== dateA) return dateB - dateA;
        return this._versionCompare(b.version_number, a.version_number);
      });

      for (const version of versions) {
        const conflicts = await this._versionConflictsWithInstalled(version);
        if (conflicts.length === 0) return version;
      }
    } catch (e) {
      console.error(`Failed to fetch compatible version for ${projectId}:`, e.message);
    }
    return null;
  }

  async _getLatestCompatibleVersion(projectId, gameVersion, loader, beforeDate) {
    return this._getBestCompatibleVersion(projectId, gameVersion, loader, beforeDate);
  }

  async _resolveDependencies(versionData, gameVersion, loader, visited = new Set()) {
    const toInstall = [];
    const conflicts = [];

    if (!versionData || !Array.isArray(versionData.dependencies)) {
      return { toInstall, conflicts };
    }

    for (const dep of versionData.dependencies) {
      if (dep.dependency_type === 'embedded') continue;

      if (dep.dependency_type === 'incompatible') {
        if (!dep.project_id) continue;
        const installed = this._modDatabase[dep.project_id];
        if (installed?.enabled && this._dependencyTargetsInstalled(dep, installed)) {
          const sourceName = versionData.name || versionData.version_number || 'This version';
          conflicts.push({
            projectId: dep.project_id,
            title: installed.title,
            reason: `${sourceName} is incompatible with installed ${installed.title}`,
          });
        }
        continue;
      }

      if (!dep.project_id) continue;
      if (visited.has(dep.project_id)) continue;
      visited.add(dep.project_id);

      const alreadyInstalled = this._modDatabase[dep.project_id];
      if (alreadyInstalled) {
        const bestVersion = await this._getBestCompatibleVersion(dep.project_id, gameVersion, loader);
        const isUpToDate = bestVersion && alreadyInstalled.installedVersion === bestVersion.id;
        if (!isUpToDate && bestVersion) {
          toInstall.push({ projectId: dep.project_id, versionData: bestVersion, isRequired: dep.dependency_type === 'required' });
          const subDeps = await this._resolveDependencies(bestVersion, gameVersion, loader, visited);
          toInstall.push(...subDeps.toInstall);
          conflicts.push(...subDeps.conflicts);
        } else if (!bestVersion && dep.dependency_type === 'required') {
          conflicts.push({
            projectId: dep.project_id,
            title: alreadyInstalled.title,
            reason: `No version of ${alreadyInstalled.title} is compatible with your other mods`,
          });
        }
        continue;
      }

      const compatibleVersion = await this._getBestCompatibleVersion(dep.project_id, gameVersion, loader);
      if (compatibleVersion) {
        toInstall.push({ projectId: dep.project_id, versionData: compatibleVersion, isRequired: dep.dependency_type === 'required' });
        const subDeps = await this._resolveDependencies(compatibleVersion, gameVersion, loader, visited);
        toInstall.push(...subDeps.toInstall);
        conflicts.push(...subDeps.conflicts);
      } else {
        if (dep.dependency_type === 'required') {
          conflicts.push({ projectId: dep.project_id, reason: `Required dependency has no version for ${gameVersion}` });
        }
      }
    }

    return { toInstall, conflicts };
  }

  async checkModsCompatibility(gameVersion, loader) {
    this._loadDatabase();

    const compatible = [];
    const updatable = [];
    const incompatible = [];
    const allDepConflicts = [];
    const visited = new Set();

    for (const [id, mod] of Object.entries(this._modDatabase)) {
      const bestVersion = await this._getBestCompatibleVersion(id, gameVersion, loader);

      if (!bestVersion) {
        incompatible.push({ projectId: id, title: mod.title, currentVersion: mod.versionNumber });
        continue;
      }

      if (mod.installedVersion === bestVersion.id) {
        compatible.push({ projectId: id, title: mod.title });
        continue;
      }

      const depResult = await this._resolveDependencies(bestVersion, gameVersion, loader, visited);
      allDepConflicts.push(...depResult.conflicts);
      updatable.push({
        projectId: id,
        title: mod.title,
        currentVersion: mod.versionNumber,
        newVersion: bestVersion.version_number,
        depCount: depResult.toInstall.length,
      });
    }

    const uniqueDepConflicts = allDepConflicts.filter(c => {
      if (this._modDatabase[c.projectId]) return true;
      return !updatable.some(u => u.projectId === c.projectId);
    });

    return {
      compatible,
      updatable,
      incompatible,
      depConflicts: uniqueDepConflicts,
    };
  }

  _fileError(err, filePath) {
    const name = path.basename(filePath || 'file');
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      return new Error(`Could not access ${name}. Close Minecraft if it is running, then try again.`);
    }
    if (err.code === 'EBUSY') {
      return new Error(`Could not access ${name}. The file is in use — close Minecraft and try again.`);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  async _safeUnlink(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return;
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        fs.unlinkSync(filePath);
        return;
      } catch (e) {
        if (attempt === maxAttempts - 1) {
          throw this._fileError(e, filePath);
        }
        await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  }

  async _safeRename(fromPath, toPath) {
    const maxAttempts = 4;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this._safeUnlink(toPath);
        fs.renameSync(fromPath, toPath);
        return;
      } catch (e) {
        if (attempt === maxAttempts - 1) {
          throw this._fileError(e, toPath);
        }
        await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
  }

  _readFabricModJson(jarPath) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(jarPath)) return resolve(null);
      yauzl.open(jarPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return resolve(null);
        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          if (entry.fileName === 'fabric.mod.json' || entry.fileName.endsWith('/fabric.mod.json')) {
            zipfile.openReadStream(entry, (err, readStream) => {
              if (err) return resolve(null);
              let buf = Buffer.alloc(0);
              readStream.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); });
              readStream.on('end', () => {
                try { resolve(JSON.parse(buf.toString('utf-8'))); }
                catch (e) { resolve(null); }
              });
            });
          } else {
            zipfile.readEntry();
          }
        });
        zipfile.on('end', () => resolve(null));
        zipfile.on('error', () => resolve(null));
      });
    });
  }

  _parseVersion(version) {
    if (!version || typeof version !== 'string') return [0, 0, 0];
    const clean = version.replace(/^[^\d]*/, '').split('-')[0].split('+')[0];
    const parts = clean.split('.').map(Number);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  }

  _versionCompare(a, b) {
    const va = this._parseVersion(a);
    const vb = this._parseVersion(b);
    for (let i = 0; i < 3; i++) {
      if (va[i] > vb[i]) return 1;
      if (va[i] < vb[i]) return -1;
    }
    return 0;
  }

  _versionSatisfies(version, range) {
    if (!range || range === '*' || range === '') return true;
    const rangeList = Array.isArray(range) ? range : [range];

    for (const r of rangeList) {
      const trimmed = r.trim();
      if (!trimmed || trimmed === '*') return true;

      if (trimmed.startsWith('>=')) {
        if (this._versionCompare(version, trimmed.slice(2)) >= 0) return true;
      } else if (trimmed.startsWith('>')) {
        if (this._versionCompare(version, trimmed.slice(1)) > 0) return true;
      } else if (trimmed.startsWith('<=')) {
        if (this._versionCompare(version, trimmed.slice(2)) <= 0) return true;
      } else if (trimmed.startsWith('<')) {
        if (this._versionCompare(version, trimmed.slice(1)) < 0) return true;
      } else if (trimmed.startsWith('^')) {
        const target = trimmed.slice(1);
        const tv = this._parseVersion(target);
        const vv = this._parseVersion(version);
        if (vv[0] === tv[0] && vv[1] >= tv[1]) return true;
        if (vv[0] > tv[0]) return true;
      } else if (trimmed.startsWith('~')) {
        const target = trimmed.slice(1);
        const tv = this._parseVersion(target);
        const vv = this._parseVersion(version);
        if (vv[0] === tv[0] && vv[1] === tv[1] && vv[2] >= tv[2]) return true;
      } else if (trimmed.includes('-')) {
        const [min, max] = trimmed.split('-');
        if (this._versionCompare(version, min) >= 0 && this._versionCompare(version, max) <= 0) return true;
      } else {
        if (this._versionCompare(version, trimmed) === 0) return true;
      }
    }
    return false;
  }

  async _checkModConflicts(projectId, gameVersion, loader) {
    const mod = this._modDatabase[projectId];
    if (!mod) return { conflicts: [], missingDeps: [] };

    const modJson = await this._readFabricModJson(mod.filePath);
    if (!modJson) return { conflicts: [], missingDeps: [] };

    const conflicts = [];
    const missingDeps = [];
    const depMap = modJson.dependencies || {};

    for (const [depId, depRange] of Object.entries(depMap)) {
      if (!depId || depId === 'minecraft' || depId === 'java' || depId === 'fabricloader') continue;

      const isRequired = !depRange.startsWith('<');
      const isBanned = depRange.startsWith('<') && !depRange.includes('>');

      const installedDep = this._modDatabase[depId];
      if (installedDep) {
        if (isBanned) {
          conflicts.push({
            modId: projectId,
            modTitle: mod.title,
            conflictId: depId,
            conflictTitle: installedDep.title,
            reason: `${mod.title} is incompatible with ${installedDep.title}`,
          });
        } else if (!this._versionSatisfies(installedDep.versionNumber, depRange)) {
          conflicts.push({
            modId: projectId,
            modTitle: mod.title,
            conflictId: depId,
            conflictTitle: installedDep.title,
            reason: `${mod.title} requires ${depId} ${depRange} but ${installedDep.title} v${installedDep.versionNumber} is installed`,
          });
        }
      } else if (isRequired && !isBanned) {
        missingDeps.push({ projectId: depId, range: depRange });
      }
    }

    const incompatMap = modJson.incompatibilities || {};
    for (const [incId, incRange] of Object.entries(incompatMap)) {
      if (!incId) continue;
      const installedInc = this._modDatabase[incId];
      if (installedInc) {
        if (!incRange || this._versionSatisfies(installedInc.versionNumber, incRange)) {
          conflicts.push({
            modId: projectId,
            modTitle: mod.title,
            conflictId: incId,
            conflictTitle: installedInc.title,
            reason: `${mod.title} is incompatible with ${installedInc.title}`,
          });
        }
      }
    }

    return { conflicts, missingDeps };
  }

  async validateAllModConflicts() {
    this._loadDatabase();
    const allConflicts = [];
    const processed = new Set();

    for (const [id, mod] of Object.entries(this._modDatabase)) {
      if (!mod.enabled || !fs.existsSync(mod.filePath)) continue;

      const installedVersion = await this._getVersion(mod.installedVersion);
      if (installedVersion) {
        const modrinthConflicts = await this._versionConflictsWithInstalled(installedVersion);
        for (const c of modrinthConflicts) {
          const key = [id, c.projectId].sort().join(':');
          if (!processed.has(key)) {
            processed.add(key);
            allConflicts.push({
              modId: id,
              modTitle: mod.title,
              conflictId: c.projectId,
              conflictTitle: c.title,
              reason: c.reason,
            });
          }
        }
      }

      const result = await this._checkModConflicts(id, null, null);
      for (const c of result.conflicts) {
        const key = [c.modId, c.conflictId].sort().join(':');
        if (!processed.has(key)) {
          processed.add(key);
          allConflicts.push(c);
        }
      }
    }
    return allConflicts;
  }

  async _resolveConflictsAfterInstall(gameVersion, loader) {
    this._loadDatabase();
    const resolved = [];
    const maxRounds = 5;

    for (let round = 0; round < maxRounds; round++) {
      const conflicts = await this.validateAllModConflicts();
      if (conflicts.length === 0) break;

      let fixedSomething = false;

      for (const conflict of conflicts) {
        const requiringMod = this._modDatabase[conflict.modId];
        if (!requiringMod) continue;

        const parentDate = requiringMod.installedAt ? new Date(requiringMod.installedAt).toISOString() : null;

        const installedDep = this._modDatabase[conflict.conflictId];
        if (!installedDep) continue;

        const newVersion = await this._getLatestCompatibleVersion(
          conflict.conflictId,
          installedDep.gameVersions[0],
          installedDep.loaders[0],
          parentDate
        );

        if (newVersion && newVersion.id !== installedDep.installedVersion) {
          try {
            await this.updateMod(conflict.conflictId, gameVersion || installedDep.gameVersions[0], loader || installedDep.loaders[0]);
            resolved.push({ replaced: conflict.conflictTitle, newVersion: newVersion.version_number, requiredBy: conflict.modTitle });
            fixedSomething = true;
          } catch (e) {
            console.error(`Failed to resolve conflict: ${e.message}`);
          }
        }
      }

      if (!fixedSomething) break;
    }

    return resolved;
  }

  async _installMissingDependency(projectId, gameVersion, loader) {
    this._loadDatabase();
    this._ensureModsDir();

    const compatibleVersion = await this._getLatestCompatibleVersion(projectId, gameVersion, loader);
    if (!compatibleVersion) return null;

    const project = await this.getProject(projectId);
    const primaryFile = compatibleVersion.files.find(f => f.primary) || compatibleVersion.files[0];
    if (!primaryFile) return null;

    const destPath = path.join(this.getMinecraftModsDirectory(), primaryFile.filename);
    if (fs.existsSync(destPath)) return null;

    await this._downloadFile(primaryFile.url, destPath);

    this._modDatabase[projectId] = {
      projectId,
      slug: project.slug,
      title: project.title,
      description: project.description,
      icon_url: project.icon_url,
      client_side: project.client_side,
      installedVersion: compatibleVersion.id,
      versionNumber: compatibleVersion.version_number,
      filename: primaryFile.filename,
      filePath: destPath,
      gameVersions: compatibleVersion.game_versions,
      loaders: compatibleVersion.loaders,
      enabled: true,
      installedAt: Date.now(),
    };

    this._dirty = true;
    this._saveDatabase();

    const depResult = await this._resolveDependencies(compatibleVersion, gameVersion, loader);
    for (const dep of depResult.toInstall) {
      if (this._modDatabase[dep.projectId]) continue;
      try {
        await this._installDependency(dep.projectId, dep.versionData, gameVersion, loader);
      } catch (e) {
        console.error(`Failed to install nested dependency ${dep.projectId}:`, e.message);
      }
    }

    return this._modDatabase[projectId];
  }

  async _installDependency(projectId, versionData, gameVersion, loader) {
    this._loadDatabase();
    this._ensureModsDir();

    const project = await this.getProject(projectId);
    const primaryFile = versionData.files.find(f => f.primary) || versionData.files[0];
    if (!primaryFile) throw new Error('No downloadable file');

    const destPath = path.join(this.getMinecraftModsDirectory(), primaryFile.filename);
    if (fs.existsSync(destPath)) return null;

    await this._downloadFile(primaryFile.url, destPath);

    this._modDatabase[projectId] = {
      projectId,
      slug: project.slug,
      title: project.title,
      description: project.description,
      icon_url: project.icon_url,
      client_side: project.client_side,
      installedVersion: versionData.id,
      versionNumber: versionData.version_number,
      filename: primaryFile.filename,
      filePath: destPath,
      gameVersions: versionData.game_versions,
      loaders: versionData.loaders,
      enabled: true,
      installedAt: Date.now(),
    };

    this._dirty = true;
    this._saveDatabase();

    const depResult = await this._resolveDependencies(versionData, gameVersion, loader);
    for (const dep of depResult.toInstall) {
      if (this._modDatabase[dep.projectId]) continue;
      try {
        await this._installDependency(dep.projectId, dep.versionData, gameVersion, loader);
      } catch (e) {
        console.error(`Failed to install nested dependency ${dep.projectId}:`, e.message);
      }
    }

    return this._modDatabase[projectId];
  }

  async _resolveAndInstallDeps(versionData, gameVersion, loader) {
    const installed = [];
    const depResult = await this._resolveDependencies(versionData, gameVersion, loader);

    for (const dep of depResult.toInstall) {
      try {
        if (this._modDatabase[dep.projectId]) {
          if (this._modDatabase[dep.projectId].installedVersion !== dep.versionData.id) {
            const result = await this.updateMod(dep.projectId, gameVersion, loader, dep.versionData);
            if (result.mod) installed.push(result.mod);
          }
        } else {
          const mod = await this._installDependency(dep.projectId, dep.versionData, gameVersion, loader);
          if (mod) installed.push(mod);
        }
      } catch (e) {
        console.error(`Failed to install dependency ${dep.projectId}:`, e.message);
      }
    }

    return { installed, conflicts: depResult.conflicts };
  }

  async installMod(projectId, versionId, gameVersion, loader) {
    this._loadDatabase();
    this._ensureModsDir();
    this._clearVersionCache();

    const project = await this.getProject(projectId);

    let targetVersion;
    if (versionId) {
      targetVersion = await this._getVersion(versionId);
      if (targetVersion) {
        const conflicts = await this._versionConflictsWithInstalled(targetVersion);
        if (conflicts.length > 0) {
          throw new Error(`Cannot install ${project.title}: incompatible with ${conflicts.map(c => c.title).join(', ')}`);
        }
      }
      if (!targetVersion) {
        const versions = await this.getProjectVersions(projectId, [gameVersion], [loader]);
        targetVersion = versions.find(v => v.id === versionId);
      }
    } else {
      targetVersion = await this._getBestCompatibleVersion(projectId, gameVersion, loader);
    }

    if (!targetVersion) {
      throw new Error(`No compatible version found for ${project.title} on ${gameVersion} ${loader} that works with your installed mods`);
    }

    const depResult = await this._resolveDependencies(targetVersion, gameVersion, loader);
    const blockingConflicts = depResult.conflicts.filter(c => c.reason?.includes('incompatible'));
    if (blockingConflicts.length > 0) {
      throw new Error(`Cannot install ${project.title}: ${blockingConflicts.map(c => c.reason || c.title).join('; ')}`);
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

    const { installed: installedDeps, conflicts: depConflicts } = await this._resolveAndInstallDeps(targetVersion, gameVersion, loader);

    const resolved = await this._resolveConflictsAfterInstall(gameVersion, loader);

    const selfConflict = await this._checkModConflicts(projectId, gameVersion, loader);
    const allConflicts = [...depConflicts.map(c => ({ ...c, source: 'dependency' })), ...selfConflict.conflicts.map(c => ({ ...c, source: 'compatibility' }))];

    return {
      mod: this._modDatabase[projectId],
      installedDeps,
      conflicts: allConflicts,
      resolved,
    };
  }

  async updateMod(projectId, gameVersion, loader, versionData = null) {
    this._loadDatabase();
    this._ensureModsDir();
    this._clearVersionCache();

    const newVersion = versionData || await this._getBestCompatibleVersion(projectId, gameVersion, loader);
    if (!newVersion) {
      throw new Error(`No compatible version found for ${projectId} on ${gameVersion} ${loader} that works with your other mods`);
    }

    const oldMod = this._modDatabase[projectId];

    if (!oldMod || oldMod.installedVersion !== newVersion.id) {
      const conflicts = await this._versionConflictsWithInstalled(newVersion);
      if (conflicts.length > 0) {
        throw new Error(`Cannot update ${oldMod?.title || projectId}: incompatible with ${conflicts.map(c => c.title).join(', ')}`);
      }
    }

    if (oldMod) {
      if (oldMod.installedVersion === newVersion.id) {
        const depResult = await this._resolveDependencies(newVersion, gameVersion, loader);
        const { installed: installedDeps } = await this._resolveAndInstallDeps(newVersion, gameVersion, loader);
        return { updated: false, mod: oldMod, deps: installedDeps, depConflicts: depResult.conflicts };
      }
    }

    const project = oldMod || await this.getProject(projectId);
    const primaryFile = newVersion.files.find(f => f.primary) || newVersion.files[0];
    if (!primaryFile) throw new Error('No downloadable file found');

    const destPath = path.join(this.getMinecraftModsDirectory(), primaryFile.filename);
    const tempPath = `${destPath}.download`;

    try {
      await this._downloadFile(primaryFile.url, tempPath);

      if (oldMod) {
        await this._safeUnlink(oldMod.filePath);
        const disabledPath = oldMod.filePath.replace(/\.jar$/i, '.jar.disabled');
        await this._safeUnlink(disabledPath);
      }

      await this._safeRename(tempPath, destPath);
    } catch (e) {
      await this._safeUnlink(tempPath).catch(() => {});
      throw e;
    }

    this._modDatabase[projectId] = {
      projectId,
      slug: project.slug,
      title: project.title,
      description: project.description,
      icon_url: project.icon_url,
      client_side: project.client_side,
      installedVersion: newVersion.id,
      versionNumber: newVersion.version_number,
      filename: primaryFile.filename,
      filePath: destPath,
      gameVersions: newVersion.game_versions,
      loaders: newVersion.loaders,
      enabled: true,
      installedAt: oldMod ? oldMod.installedAt : Date.now(),
    };

    this._dirty = true;
    this._saveDatabase();

    const { installed: installedDeps, conflicts: depConflicts } = await this._resolveAndInstallDeps(newVersion, gameVersion, loader);

    const resolved = await this._resolveConflictsAfterInstall(gameVersion, loader);

    const selfConflict = await this._checkModConflicts(projectId, gameVersion, loader);
    const allConflicts = [...depConflicts.map(c => ({ ...c, source: 'dependency' })), ...selfConflict.conflicts.map(c => ({ ...c, source: 'compatibility' }))];

    return { updated: true, mod: this._modDatabase[projectId], deps: installedDeps, depConflicts: allConflicts, resolved };
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
    await this._safeUnlink(destPath);

    return new Promise((resolve, reject) => {
      fs.ensureDirSync(path.dirname(destPath));
      const file = fs.createWriteStream(destPath);

      const fail = (err) => {
        file.destroy();
        this._safeUnlink(destPath).catch(() => {});
        reject(this._fileError(err, destPath));
      };

      file.on('error', fail);

      https.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.destroy();
          this._safeUnlink(destPath)
            .then(() => this._downloadFile(res.headers.location, destPath))
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode >= 400) {
          fail(new Error(`Download failed (${res.statusCode})`));
          return;
        }

        res.on('error', fail);
        res.pipe(file);
        file.on('finish', () => {
          file.close((err) => {
            if (err) fail(err);
            else resolve();
          });
        });
      }).on('error', fail);
    });
  }
}

module.exports = new ModManager();
