const { spawn } = require('child_process')
const fs = require('fs-extra')
const os = require('os')
const path = require('path')

function runProcess(command, args, { input, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${command} timed out`))
    }, timeoutMs || 20000)

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error((stderr || stdout || `${command} exited ${code}`).trim()))
    })
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}

function parseJsonOutput(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) throw new Error('Empty SQLite result')
  const startArr = trimmed.indexOf('[')
  const startObj = trimmed.indexOf('{')
  let start = -1
  if (startArr === -1) start = startObj
  else if (startObj === -1) start = startArr
  else start = Math.min(startArr, startObj)
  const jsonText = start >= 0 ? trimmed.slice(start) : trimmed
  return JSON.parse(jsonText)
}

function pythonScript() {
  return [
    'import json, sqlite3, sys',
    'spec = json.load(sys.stdin)',
    "con = sqlite3.connect('file:' + spec['db'] + '?mode=ro', uri=True, timeout=8)",
    'con.row_factory = sqlite3.Row',
    '',
    'def dump(rows):',
    '    out = []',
    '    for row in rows:',
    '        item = {}',
    '        for k in row.keys():',
    '            v = row[k]',
    '            if isinstance(v, (bytes, bytearray)):',
    '                continue',
    '            item[k] = v',
    '        out.append(item)',
    '    return out',
    '',
    'queries = spec.get("queries")',
    'if queries:',
    '    result = {name: dump(con.execute(sql).fetchall()) for name, sql in queries.items()}',
    '    json.dump(result, sys.stdout, default=str)',
    'else:',
    '    json.dump(dump(con.execute(spec["sql"]).fetchall()), sys.stdout, default=str)',
  ].join('\n')
}

async function queryWithPython(dbPath, spec) {
  const payload = JSON.stringify({ db: dbPath, ...spec })
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']
  let lastError = null
  for (const cmd of candidates) {
    try {
      const args = cmd === 'py' ? ['-3', '-c', pythonScript()] : ['-c', pythonScript()]
      const stdout = await runProcess(cmd, args, { input: payload, timeoutMs: 20000 })
      return parseJsonOutput(stdout)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError || new Error('Python SQLite helper failed')
}

function getWinSqliteScriptPath() {
  return path.join(__dirname, 'winsqlite-query.ps1')
}

async function queryWithWinSqlite(dbPath, spec) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmic-sqlite-'))
  const specPath = path.join(dir, 'spec.json')
  const scriptPath = path.join(dir, 'query.ps1')
  try {
    await fs.writeFile(specPath, JSON.stringify({ db: dbPath, ...spec }), 'utf8')
    await fs.copy(getWinSqliteScriptPath(), scriptPath)
    const stdout = await runProcess('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      specPath,
    ], { timeoutMs: 25000 })
    return parseJsonOutput(stdout)
  } finally {
    try { await fs.remove(dir) } catch (_) {}
  }
}

async function queryWithSqliteCli(dbPath, sql) {
  const stdout = await runProcess('sqlite3', ['-json', '-readonly', dbPath, sql], { timeoutMs: 20000 })
  return parseJsonOutput(stdout)
}

async function querySqliteRaw(dbPath, spec) {
  const errors = []
  try {
    return await queryWithPython(dbPath, spec)
  } catch (err) {
    errors.push(err)
  }
  if (process.platform === 'win32') {
    try {
      return await queryWithWinSqlite(dbPath, spec)
    } catch (err) {
      errors.push(err)
    }
  }
  if (spec.sql) {
    try {
      return await queryWithSqliteCli(dbPath, spec.sql)
    } catch (err) {
      errors.push(err)
    }
  }
  const detail = errors.map((e) => e.message).filter(Boolean).join('; ')
  throw new Error(detail || 'Could not query SQLite database')
}

async function querySqlite(dbPath, sql) {
  const result = await querySqliteRaw(dbPath, { sql })
  if (!Array.isArray(result)) throw new Error('SQLite result was not a list')
  return result
}

async function querySqliteMany(dbPath, queries) {
  const result = await querySqliteRaw(dbPath, { queries })
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('SQLite batch result was invalid')
  }
  return result
}

module.exports = { querySqlite, querySqliteMany }
