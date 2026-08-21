#!/usr/bin/env node
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const flags = new Set(process.argv.slice(2))
const wantWin = flags.has('--win')
const wantLinux = flags.has('--linux')
const wantMac = flags.has('--mac')
const wantAll = !wantWin && !wantLinux && !wantMac

function fail(message) {
  console.error(message)
  process.exit(1)
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32' && !command.endsWith('.exe'),
    ...opts,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exit(result.status == null ? 1 : result.status)
  }
}

function runCapture(command, args) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
}

function toWslPath(winPath) {
  const result = runCapture('wsl.exe', ['-e', 'wslpath', '-a', winPath])
  if (result.status !== 0) {
    fail((result.stderr || result.stdout || 'wslpath failed').trim())
  }
  return result.stdout.trim()
}

function assertWsl() {
  const result = runCapture('wsl.exe', ['-e', 'bash', '-lc', 'echo ok'])
  if (result.status !== 0 || !String(result.stdout || '').includes('ok')) {
    fail('WSL is required to build Linux packages from Windows. Install WSL and try again.')
  }
}

function buildWindows() {
  console.log('Building Windows installer...')
  run('npx', ['electron-builder', '--win'])
}

function buildMac() {
  console.log('Building macOS package...')
  run('npx', ['electron-builder', '--mac'])
}

function buildLinuxNative() {
  console.log('Building Linux .deb...')
  run('npx', ['electron-builder', '--linux', 'deb', '--x64'])
}

function buildLinuxViaWsl() {
  assertWsl()
  const wslSrc = toWslPath(repoRoot)
  const scriptPath = path.join(__dirname, 'build-linux.sh')
  const script = fs.readFileSync(scriptPath, 'utf8').replace(/\r\n/g, '\n')
  console.log(`Building Linux .deb via WSL (${wslSrc})...`)
  const result = spawnSync('wsl.exe', ['-e', 'bash', '-s', wslSrc], {
    cwd: repoRoot,
    stdio: ['pipe', 'inherit', 'inherit'],
    input: script,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    fail('Linux build via WSL failed.')
  }
}

function buildLinux() {
  if (process.platform === 'linux') {
    buildLinuxNative()
    return
  }
  if (process.platform === 'win32') {
    buildLinuxViaWsl()
    return
  }
  fail('Linux builds from this OS need WSL or a Linux host.')
}

if (wantAll) {
  if (process.platform === 'win32') {
    buildWindows()
    buildLinuxViaWsl()
  } else if (process.platform === 'linux') {
    buildLinuxNative()
  } else if (process.platform === 'darwin') {
    buildMac()
  } else {
    fail(`Unsupported build host: ${process.platform}`)
  }
} else {
  if (wantWin) buildWindows()
  if (wantLinux) buildLinux()
  if (wantMac) buildMac()
}
