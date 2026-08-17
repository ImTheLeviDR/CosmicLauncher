const fs = require('fs-extra')
const path = require('path')
const crypto = require('crypto')
const https = require('https')
const ConfigManager = require('./configmanager')
const ModpackManager = require('./modpackmanager')
const { querySqlite, querySqliteMany } = require('./sqlitequery')

const MODRINTH_API = 'https://api.modrinth.com/v2'
const USER_AGENT = 'CosmicLauncher/0.1.2'
const COSMIC_LOADERS = new Set(['vanilla', 'fabric'])
const SKIP_COPY_DIRS = new Set(['logs', 'crash-reports'])

function sqlEscape(value) {
  return String(value).replace(/'/g, "''")
}

function capitalizeLoader(loader) {
  const labels = {
    vanilla: 'Vanilla',
    fabric: 'Fabric',
    forge: 'Forge',
    neoforge: 'NeoForge',
    quilt: 'Quilt',
  }
  const id = String(loader || 'vanilla').toLowerCase()
  if (labels[id]) return labels[id]
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Vanilla'
}

function mapCosmicLoader(loader) {
  const id = String(loader || 'vanilla').toLowerCase()
  if (id === 'fabric' || id === 'quilt') return 'fabric'
  return 'vanilla'
}

function secondsToMs(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n * 1000)
}

function timestampToMs(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n)
}

function playTimeMsFromRow(row) {
  const submitted = secondsToMs(row.submitted_time_played)
  const recent = secondsToMs(row.recent_time_played)
  const combined = submitted + recent
  if (combined > 0) return combined
  return secondsToMs(row.time_played)
}

class ModrinthImporter {
  getCandidateRoots() {
    const roots = []
    if (process.platform === 'win32') {
      if (process.env.APPDATA) {
        roots.push(path.join(process.env.APPDATA, 'ModrinthApp'))
        roots.push(path.join(process.env.APPDATA, 'com.modrinth.theseus'))
      }
    } else if (process.platform === 'darwin') {
      const home = process.env.HOME || ''
      roots.push(path.join(home, 'Library', 'Application Support', 'ModrinthApp'))
      roots.push(path.join(home, 'Library', 'Application Support', 'com.modrinth.theseus'))
    } else {
      const home = process.env.HOME || ''
      const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share')
      roots.push(path.join(dataHome, 'ModrinthApp'))
      roots.push(path.join(dataHome, 'com.modrinth.theseus'))
    }
    return roots.filter((dir) => fs.existsSync(dir))
  }

  getDbPath(root) {
    const dbPath = path.join(root, 'app.db')
    return fs.existsSync(dbPath) ? dbPath : null
  }

  getProfilesDir(root) {
    const dir = path.join(root, 'profiles')
    return fs.existsSync(dir) ? dir : null
  }

  tableExists(rows, name) {
    return (rows || []).some((row) => String(row.name || row.NAME || '').toLowerCase() === name)
  }

  profilesDirFromSettings(root, settingsRows) {
    const custom = settingsRows && settingsRows[0] && settingsRows[0].custom_dir
    const customDir = custom && fs.existsSync(custom) ? custom : root
    return path.join(customDir, 'profiles')
  }

  async listFromDatabase(root) {
    const dbPath = this.getDbPath(root)
    if (!dbPath) return []
    const settings = 'SELECT custom_dir FROM settings LIMIT 1'

    const instanceQueries = [
      `SELECT i.id, i.path, i.name, i.install_stage, i.icon_path, i.last_played, i.created,
               i.submitted_time_played, i.recent_time_played,
               cs.game_version, cs.loader, cs.loader_version
        FROM instances i
        LEFT JOIN instance_content_sets cs ON cs.id = i.applied_content_set_id
        ORDER BY COALESCE(i.last_played, 0) DESC, i.name COLLATE NOCASE`,
      `SELECT i.id, i.path, i.name, i.install_stage, i.icon_path, i.last_played, i.created,
               cs.game_version, cs.loader, cs.loader_version
        FROM instances i
        LEFT JOIN instance_content_sets cs ON cs.id = i.applied_content_set_id
        ORDER BY COALESCE(i.last_played, 0) DESC, i.name COLLATE NOCASE`,
    ]
    for (const instances of instanceQueries) {
      try {
        const data = await querySqliteMany(dbPath, { settings, instances })
        const profilesDir = this.profilesDirFromSettings(root, data.settings)
        return (data.instances || []).map((row) => this.normalizeInstance(row, profilesDir)).filter(Boolean)
      } catch (_) {}
    }

    const profileQueries = [
      `SELECT path AS id, path, name, install_stage, icon_path, last_played, created,
               submitted_time_played, recent_time_played,
               game_version, mod_loader AS loader, mod_loader_version AS loader_version
        FROM profiles
        ORDER BY COALESCE(last_played, 0) DESC, name COLLATE NOCASE`,
      `SELECT path AS id, path, name, install_stage, icon_path, last_played, created,
               game_version, mod_loader AS loader, mod_loader_version AS loader_version
        FROM profiles
        ORDER BY COALESCE(last_played, 0) DESC, name COLLATE NOCASE`,
    ]
    for (const profiles of profileQueries) {
      try {
        const data = await querySqliteMany(dbPath, { settings, profiles })
        const profilesDir = this.profilesDirFromSettings(root, data.settings)
        return (data.profiles || []).map((row) => this.normalizeInstance(row, profilesDir)).filter(Boolean)
      } catch (_) {}
    }

    return []
  }

  listFromFolders(root) {
    const profilesDir = this.getProfilesDir(root)
    if (!profilesDir) return []
    return fs.readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !SKIP_COPY_DIRS.has(entry.name.toLowerCase()))
      .map((entry) => {
        const instanceDir = path.join(profilesDir, entry.name)
        const modsDir = path.join(instanceDir, 'mods')
        const hasMods = fs.existsSync(modsDir) && fs.readdirSync(modsDir).some((file) => /\.jar(\.disabled)?$/i.test(file))
        return this.normalizeInstance({
          id: `folder:${entry.name}`,
          path: entry.name,
          name: entry.name,
          game_version: null,
          loader: hasMods ? 'fabric' : 'vanilla',
          last_played: null,
          created: null,
          submitted_time_played: 0,
          recent_time_played: 0,
        }, profilesDir)
      })
      .filter(Boolean)
  }

  normalizeInstance(row, profilesDir) {
    const relativePath = String(row.path || '').trim()
    if (!relativePath) return null
    const instanceDir = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(profilesDir, relativePath)
    if (!fs.existsSync(instanceDir)) return null

    const sourceLoader = String(row.loader || 'vanilla').toLowerCase()
    const version = row.game_version || null
    return {
      id: String(row.id || relativePath),
      name: String(row.name || relativePath),
      path: relativePath,
      instanceDir,
      version,
      sourceLoader,
      loaderLabel: capitalizeLoader(sourceLoader),
      cosmicLoader: mapCosmicLoader(sourceLoader),
      supported: COSMIC_LOADERS.has(sourceLoader),
      lastPlayed: timestampToMs(row.last_played),
      created: timestampToMs(row.created),
      playTimeMs: playTimeMsFromRow(row),
      iconPath: row.icon_path && fs.existsSync(row.icon_path) ? row.icon_path : null,
    }
  }

  async listInstances() {
    const roots = this.getCandidateRoots()
    if (!roots.length) {
      return { success: true, foundApp: false, instances: [] }
    }

    const seen = new Set()
    const instances = []
    let foundApp = false

    for (const root of roots) {
      foundApp = true
      let listed = []
      try {
        listed = await this.listFromDatabase(root)
      } catch (err) {
        console.error('Failed to read Modrinth App database:', err)
        listed = this.listFromFolders(root)
      }
      if (!listed.length) {
        listed = this.listFromFolders(root)
      }
      for (const instance of listed) {
        const key = path.resolve(instance.instanceDir).toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        instances.push(instance)
      }
    }

    instances.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || a.name.localeCompare(b.name))
    return { success: true, foundApp, instances }
  }

  async listDisabledModFiles(instance) {
    const roots = this.getCandidateRoots()
    for (const root of roots) {
      const dbPath = this.getDbPath(root)
      if (!dbPath) continue
      try {
        const tables = await querySqlite(dbPath, "SELECT name FROM sqlite_master WHERE type='table'")
        if (!this.tableExists(tables, 'instance_files')) continue
        const rows = await querySqlite(dbPath, `
          SELECT relative_path, enabled
          FROM instance_files
          WHERE instance_id = '${sqlEscape(instance.id)}'
            AND relative_path LIKE 'mods/%'
        `)
        return rows
          .filter((row) => Number(row.enabled) === 0 && row.relative_path)
          .map((row) => String(row.relative_path).replace(/\\/g, '/'))
      } catch (err) {
        console.error('Failed to read disabled Modrinth mods:', err)
      }
    }
    return []
  }

  applyDisabledMods(destDir, disabledPaths) {
    for (const relativePath of disabledPaths) {
      const src = path.join(destDir, relativePath)
      if (!fs.existsSync(src)) continue
      if (/\.disabled$/i.test(src)) continue
      const dest = src.replace(/\.jar$/i, '.jar.disabled')
      if (src === dest) continue
      try {
        if (fs.existsSync(dest)) fs.removeSync(dest)
        fs.renameSync(src, dest)
      } catch (err) {
        console.error('Failed to disable imported mod:', src, err)
      }
    }
  }

  hashFile(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha1')
      const stream = fs.createReadStream(filePath)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
      stream.on('error', reject)
    })
  }

  async fetchJson(url, { method, body } = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const payload = body ? JSON.stringify(body) : null
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: method || 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          ...(payload ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          } : {}),
        },
      }, (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`Modrinth API ${res.statusCode}`))
            return
          }
          try {
            resolve(data ? JSON.parse(data) : {})
          } catch (err) {
            reject(err)
          }
        })
      })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  chunk(items, size) {
    const out = []
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
    return out
  }

  async lookupVersionsByHashes(hashes) {
    const found = {}
    for (const group of this.chunk(hashes, 64)) {
      if (!group.length) continue
      try {
        const data = await this.fetchJson(`${MODRINTH_API}/version_files`, {
          method: 'POST',
          body: { hashes: group, algorithm: 'sha1' },
        })
        Object.assign(found, data || {})
      } catch (err) {
        console.error('Modrinth hash lookup failed:', err)
      }
    }
    return found
  }

  async lookupProjects(ids) {
    const found = {}
    for (const group of this.chunk(ids, 64)) {
      if (!group.length) continue
      try {
        const data = await this.fetchJson(`${MODRINTH_API}/projects?ids=${encodeURIComponent(JSON.stringify(group))}`)
        for (const project of data || []) found[project.id] = project
      } catch (err) {
        console.error('Modrinth project lookup failed:', err)
      }
    }
    return found
  }

  collectModFiles(modsDir) {
    if (!fs.existsSync(modsDir)) return []
    return fs.readdirSync(modsDir)
      .filter((name) => /\.jar(\.disabled)?$/i.test(name))
      .map((name) => {
        const filePath = path.join(modsDir, name)
        const enabled = !/\.disabled$/i.test(name)
        const filename = name.replace(/\.disabled$/i, '')
        return { filePath, filename, enabled }
      })
  }

  async buildModsDatabase(destDir, loader) {
    const modsDir = path.join(destDir, 'mods')
    const files = this.collectModFiles(modsDir)
    if (!files.length) return 0

    const hashed = []
    for (const file of files) {
      try {
        hashed.push({ ...file, sha1: await this.hashFile(file.filePath) })
      } catch (err) {
        console.error('Failed to hash imported mod:', file.filePath, err)
      }
    }

    const versions = await this.lookupVersionsByHashes(hashed.map((file) => file.sha1))
    const projectIds = [...new Set(Object.values(versions).map((version) => version.project_id).filter(Boolean))]
    const projects = await this.lookupProjects(projectIds)

    const database = {}
    for (const file of hashed) {
      const version = versions[file.sha1]
      if (!version || !version.project_id) continue
      const project = projects[version.project_id] || {}
      database[version.project_id] = {
        projectId: version.project_id,
        slug: project.slug || version.project_id,
        title: project.title || version.name || file.filename,
        description: project.description || '',
        icon_url: project.icon_url || null,
        client_side: project.client_side || 'unknown',
        installedVersion: version.id,
        versionNumber: version.version_number,
        filename: file.filename,
        filePath: file.enabled ? file.filePath : file.filePath.replace(/\.disabled$/i, ''),
        gameVersions: version.game_versions || [],
        loaders: version.loaders || [loader],
        enabled: file.enabled,
        installedAt: Date.now(),
      }
    }

    fs.writeFileSync(path.join(destDir, 'mods-database.json'), JSON.stringify(database, null, 2), 'utf-8')
    return Object.keys(database).length
  }

  async importInstance(instanceId) {
    const listed = await this.listInstances()
    const instance = (listed.instances || []).find((item) => item.id === instanceId)
    if (!instance) throw new Error('Modrinth instance not found')
    if (!fs.existsSync(instance.instanceDir)) throw new Error('Modrinth instance folder is missing')

    const version = instance.version || ConfigManager.getSelectedVersion() || 'latest'
    const loader = instance.cosmicLoader
    const name = ModpackManager.uniqueName(instance.name)
    const disabledPaths = await this.listDisabledModFiles(instance)

    const pack = ModpackManager.importFromDirectory({
      name,
      version,
      loader,
      sourceDir: instance.instanceDir,
      sourceLoader: instance.sourceLoader,
      playTimeMs: instance.playTimeMs,
      lastPlayedAt: instance.lastPlayed,
    })

    const destDir = ModpackManager.getInstanceDirectory(pack.id)
    this.applyDisabledMods(destDir, disabledPaths)
    let indexedMods = 0
    try {
      indexedMods = await this.buildModsDatabase(destDir, loader)
    } catch (err) {
      console.error('Failed to index imported mods:', err)
    }

    return { pack, indexedMods, supported: instance.supported, sourceLoader: instance.sourceLoader }
  }
}

module.exports = new ModrinthImporter()
