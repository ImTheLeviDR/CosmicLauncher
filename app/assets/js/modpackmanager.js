const fs = require('fs-extra')
const path = require('path')
const crypto = require('crypto')
const ConfigManager = require('./configmanager')

const DEFAULT_PACK_ID = 'default'

function createId() {
  return crypto.randomBytes(8).toString('hex')
}

class ModpackManager {
  constructor() {
    this._data = null
  }

  getModpacksPath() {
    return path.join(ConfigManager.getLauncherDirectory(), 'modpacks.json')
  }

  getInstancesRoot() {
    return path.join(ConfigManager.getLauncherDirectory(), 'instances')
  }

  getInstanceDirectory(modpackId) {
    return path.join(this.getInstancesRoot(), modpackId || DEFAULT_PACK_ID)
  }

  getDefaultData() {
    return {
      selectedModpackId: DEFAULT_PACK_ID,
      syncOptionsAcrossModpacks: true,
      modpacks: [
        {
          id: DEFAULT_PACK_ID,
          name: 'Latest',
          version: 'latest',
          loader: 'vanilla',
          isDefault: true,
          createdAt: Date.now(),
        },
      ],
    }
  }

  load() {
    const filePath = this.getModpacksPath()
    if (!fs.existsSync(filePath)) {
      this._data = this.getDefaultData()
      this._migrateLegacyInstance()
      this.save()
      return this._data
    }

    try {
      this._data = { ...this.getDefaultData(), ...JSON.parse(fs.readFileSync(filePath, 'utf-8')) }
      if (!Array.isArray(this._data.modpacks) || this._data.modpacks.length === 0) {
        this._data.modpacks = this.getDefaultData().modpacks
      }
      if (!this._data.modpacks.some((p) => p.id === DEFAULT_PACK_ID)) {
        this._data.modpacks.unshift(this.getDefaultData().modpacks[0])
      }
      if (!this._data.modpacks.some((p) => p.id === this._data.selectedModpackId)) {
        this._data.selectedModpackId = DEFAULT_PACK_ID
      }
      if (typeof this._data.syncOptionsAcrossModpacks !== 'boolean') {
        this._data.syncOptionsAcrossModpacks = true
      }
      this._ensureInstanceDirs()
      this.save()
    } catch (err) {
      console.error('Error loading modpacks:', err)
      this._data = this.getDefaultData()
      this._migrateLegacyInstance()
      this.save()
    }

    return this._data
  }

  save() {
    if (!this._data) return
    fs.ensureDirSync(ConfigManager.getLauncherDirectory())
    fs.writeFileSync(this.getModpacksPath(), JSON.stringify(this._data, null, 2), 'utf-8')
  }

  _ensureLoaded() {
    if (!this._data) this.load()
  }

  _ensureInstanceDirs() {
    this._ensureLoaded()
    for (const pack of this._data.modpacks) {
      fs.ensureDirSync(path.join(this.getInstanceDirectory(pack.id), 'mods'))
    }
  }

  _migrateLegacyInstance() {
    const launcherDir = ConfigManager.getLauncherDirectory()
    const legacyMinecraft = path.join(launcherDir, 'minecraft')
    const legacyMods = path.join(legacyMinecraft, 'mods')
    const legacyDb = path.join(launcherDir, 'mods-database.json')
    const legacyOptions = path.join(legacyMinecraft, 'options.txt')
    const defaultDir = this.getInstanceDirectory(DEFAULT_PACK_ID)

    fs.ensureDirSync(path.join(defaultDir, 'mods'))

    let hasLegacyDb = false
    if (fs.existsSync(legacyDb)) {
      try {
        hasLegacyDb = Object.keys(JSON.parse(fs.readFileSync(legacyDb, 'utf-8') || '{}')).length > 0
      } catch (_) {}
    }
    const hasLegacyMods =
      (fs.existsSync(legacyMods) && fs.readdirSync(legacyMods).some((f) => f.endsWith('.jar') || f.endsWith('.jar.disabled'))) ||
      hasLegacyDb

    if (hasLegacyMods) {
      const legacyId = 'legacy'
      if (!this._data.modpacks.some((p) => p.id === legacyId)) {
        this._data.modpacks.push({
          id: legacyId,
          name: 'Previous Setup',
          version: ConfigManager.getSelectedVersion() || 'latest',
          loader: ConfigManager.getSelectedLoader() || 'fabric',
          isDefault: false,
          createdAt: Date.now(),
        })
      }

      const legacyDir = this.getInstanceDirectory(legacyId)
      fs.ensureDirSync(path.join(legacyDir, 'mods'))

      if (fs.existsSync(legacyMods)) {
        for (const file of fs.readdirSync(legacyMods)) {
          const src = path.join(legacyMods, file)
          const dest = path.join(legacyDir, 'mods', file)
          if (!fs.existsSync(dest)) {
            try {
              fs.moveSync(src, dest)
            } catch (e) {
              try {
                fs.copyFileSync(src, dest)
              } catch (_) {}
            }
          }
        }
      }

      if (fs.existsSync(legacyDb)) {
        const destDb = path.join(legacyDir, 'mods-database.json')
        if (!fs.existsSync(destDb)) {
          try {
            const db = JSON.parse(fs.readFileSync(legacyDb, 'utf-8'))
            for (const mod of Object.values(db)) {
              if (mod.filename) {
                mod.filePath = path.join(legacyDir, 'mods', mod.filename)
              }
            }
            fs.writeFileSync(destDb, JSON.stringify(db, null, 2), 'utf-8')
            fs.removeSync(legacyDb)
          } catch (e) {
            console.error('Failed to migrate mods database:', e)
          }
        }
      }

      if (fs.existsSync(legacyOptions)) {
        const destOptions = path.join(legacyDir, 'options.txt')
        if (!fs.existsSync(destOptions)) {
          try {
            fs.copyFileSync(legacyOptions, destOptions)
          } catch (_) {}
        }
      }

      this._data.selectedModpackId = legacyId
    } else if (fs.existsSync(legacyOptions)) {
      const destOptions = path.join(defaultDir, 'options.txt')
      if (!fs.existsSync(destOptions)) {
        try {
          fs.copyFileSync(legacyOptions, destOptions)
        } catch (_) {}
      }
    }

    this._ensureInstanceDirs()
  }

  list() {
    this._ensureLoaded()
    return this._data.modpacks.map((p) => ({ ...p }))
  }

  getSelectedId() {
    this._ensureLoaded()
    return this._data.selectedModpackId || DEFAULT_PACK_ID
  }

  getSelected() {
    return this.getById(this.getSelectedId())
  }

  getById(id) {
    this._ensureLoaded()
    return this._data.modpacks.find((p) => p.id === id) || null
  }

  setSelected(id) {
    this._ensureLoaded()
    const pack = this.getById(id)
    if (!pack) throw new Error('Modpack not found')
    this._data.selectedModpackId = id
    this.save()

    if (pack.version && pack.version !== 'latest') {
      ConfigManager.setSelectedVersion(pack.version)
    }
    ConfigManager.setSelectedLoader(pack.loader || 'vanilla')
    ConfigManager.save()

    return { ...pack }
  }

  getSyncOptionsEnabled() {
    this._ensureLoaded()
    return this._data.syncOptionsAcrossModpacks !== false
  }

  setSyncOptionsEnabled(enabled) {
    this._ensureLoaded()
    this._data.syncOptionsAcrossModpacks = enabled === true
    this.save()
    return this._data.syncOptionsAcrossModpacks
  }

  create({ name, version, loader }) {
    this._ensureLoaded()
    const trimmed = (name || '').trim()
    if (!trimmed) throw new Error('Modpack name is required')
    if (!version) throw new Error('Minecraft version is required')

    const id = createId()
    const pack = {
      id,
      name: trimmed,
      version,
      loader: loader === 'fabric' ? 'fabric' : 'vanilla',
      isDefault: false,
      createdAt: Date.now(),
    }

    this._data.modpacks.push(pack)
    fs.ensureDirSync(path.join(this.getInstanceDirectory(id), 'mods'))
    this.save()
    return { ...pack }
  }

  uniqueName(name) {
    this._ensureLoaded()
    const base = (name || 'Imported pack').trim() || 'Imported pack'
    const names = new Set(this._data.modpacks.map((p) => p.name.toLowerCase()))
    if (!names.has(base.toLowerCase())) return base
    let n = 2
    while (names.has(`${base} (${n})`.toLowerCase())) n++
    return `${base} (${n})`
  }

  importFromDirectory({ name, version, loader, sourceDir, sourceLoader }) {
    this._ensureLoaded()
    const trimmed = (name || '').trim()
    if (!trimmed) throw new Error('Modpack name is required')
    if (!version) throw new Error('Minecraft version is required')
    if (!sourceDir || !fs.existsSync(sourceDir)) throw new Error('Instance folder is missing')

    const id = createId()
    const destDir = this.getInstanceDirectory(id)
    fs.ensureDirSync(this.getInstancesRoot())
    fs.copySync(sourceDir, destDir, {
      filter: (src) => {
        const rel = path.relative(sourceDir, src)
        if (!rel || rel === '.') return true
        const top = rel.split(path.sep)[0].toLowerCase()
        return top !== 'logs' && top !== 'crash-reports'
      },
    })
    fs.ensureDirSync(path.join(destDir, 'mods'))

    const pack = {
      id,
      name: trimmed,
      version,
      loader: loader === 'fabric' ? 'fabric' : 'vanilla',
      isDefault: false,
      createdAt: Date.now(),
      importedFrom: 'modrinth',
      sourceLoader: sourceLoader || loader || 'vanilla',
    }

    this._data.modpacks.push(pack)
    this.save()
    return { ...pack }
  }

  update(id, { name, version, loader }) {
    this._ensureLoaded()
    const pack = this.getById(id)
    if (!pack) throw new Error('Modpack not found')
    if (pack.isDefault) {
      throw new Error('The default Latest modpack cannot be edited')
    }

    if (name != null) {
      const trimmed = String(name).trim()
      if (!trimmed) throw new Error('Modpack name is required')
      pack.name = trimmed
    }
    if (version != null) pack.version = version
    if (loader != null) pack.loader = loader === 'fabric' ? 'fabric' : 'vanilla'

    this.save()

    if (this._data.selectedModpackId === id) {
      if (pack.version !== 'latest') ConfigManager.setSelectedVersion(pack.version)
      ConfigManager.setSelectedLoader(pack.loader)
      ConfigManager.save()
    }

    return { ...pack }
  }

  remove(id) {
    this._ensureLoaded()
    const pack = this.getById(id)
    if (!pack) throw new Error('Modpack not found')
    if (pack.isDefault || id === DEFAULT_PACK_ID) {
      throw new Error('The default Latest modpack cannot be deleted')
    }

    this._data.modpacks = this._data.modpacks.filter((p) => p.id !== id)
    if (this._data.selectedModpackId === id) {
      this._data.selectedModpackId = DEFAULT_PACK_ID
    }
    this.save()

    const dir = this.getInstanceDirectory(id)
    try {
      if (fs.existsSync(dir)) fs.removeSync(dir)
    } catch (e) {
      console.error('Failed to remove modpack directory:', e)
    }

    return true
  }

  /**
   * Find the newest options.txt across all instances and copy it into the target.
   */
  syncOptionsToInstance(targetModpackId) {
    this._ensureLoaded()
    if (!this.getSyncOptionsEnabled()) return { synced: false, reason: 'disabled' }

    const targetDir = this.getInstanceDirectory(targetModpackId)
    fs.ensureDirSync(targetDir)
    const targetOptions = path.join(targetDir, 'options.txt')

    let newestPath = null
    let newestMtime = -1

    for (const pack of this._data.modpacks) {
      const optionsPath = path.join(this.getInstanceDirectory(pack.id), 'options.txt')
      if (!fs.existsSync(optionsPath)) continue
      try {
        const mtime = fs.statSync(optionsPath).mtimeMs
        if (mtime > newestMtime) {
          newestMtime = mtime
          newestPath = optionsPath
        }
      } catch (_) {}
    }

    if (!newestPath) return { synced: false, reason: 'none' }
    if (path.resolve(newestPath) === path.resolve(targetOptions)) {
      return { synced: false, reason: 'already-newest' }
    }

    let targetMtime = -1
    if (fs.existsSync(targetOptions)) {
      try {
        targetMtime = fs.statSync(targetOptions).mtimeMs
      } catch (_) {}
    }

    if (newestMtime <= targetMtime) {
      return { synced: false, reason: 'target-newer' }
    }

    fs.copyFileSync(newestPath, targetOptions)
    return { synced: true, from: newestPath, to: targetOptions }
  }
}

module.exports = new ModpackManager()
