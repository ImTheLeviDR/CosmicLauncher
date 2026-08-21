#!/usr/bin/env bash
set -euo pipefail

SRC="${1:?Usage: build-linux.sh <repo-path-in-wsl>}"
WORK="${XDG_CACHE_HOME:-$HOME/.cache}/cosmic-launcher-linux-build"

if [[ ! -d "$SRC" ]]; then
  echo "Source directory does not exist: $SRC" >&2
  exit 1
fi

# Windows PATH entries via WSL interop make npm/electron run cmd.exe. Keep Linux only.
LINUX_PATH="$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH="$LINUX_PATH"
hash -r
unset npm_config_prefix
export npm_config_script_shell="/bin/bash"

echo "Using $(command -v node) $(node -v 2>/dev/null || true)"
echo "Using $(command -v npm) $(npm -v 2>/dev/null || true)"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "Node.js and npm are required inside WSL (Linux binaries, not Windows)." >&2
  exit 1
fi

ensure_fakeroot() {
  if command -v fakeroot >/dev/null 2>&1; then
    echo "Using fakeroot at $(command -v fakeroot)"
    return 0
  fi

  local prefix="${XDG_CACHE_HOME:-$HOME/.cache}/cosmic-fakeroot"
  mkdir -p "$prefix"
  if [[ -x "$prefix/usr/bin/fakeroot" ]]; then
    export PATH="$prefix/usr/bin:$PATH"
    export LD_LIBRARY_PATH="$prefix/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
    echo "Using bundled fakeroot at $prefix/usr/bin/fakeroot"
    return 0
  fi

  echo "Installing fakeroot into $prefix (no sudo)"
  local tmp
  tmp="$(mktemp -d)"
  (
    cd "$tmp"
    apt-get download fakeroot libfakeroot
    dpkg-deb -x fakeroot_*.deb "$prefix"
    dpkg-deb -x libfakeroot_*.deb "$prefix"
  )
  rm -rf "$tmp"
  export PATH="$prefix/usr/bin:$PATH"
  export LD_LIBRARY_PATH="$prefix/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
  if ! command -v fakeroot >/dev/null 2>&1; then
    echo "Could not provide fakeroot, which is required to build .deb packages." >&2
    exit 1
  fi
  echo "Using bundled fakeroot at $(command -v fakeroot)"
}

ensure_fakeroot

mkdir -p "$WORK"

echo "Syncing sources to $WORK"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude node_modules \
    --exclude dist \
    --exclude .git \
    --exclude .cursor \
    "$SRC/" "$WORK/"
else
  tar -C "$SRC" \
    --exclude=node_modules \
    --exclude=dist \
    --exclude=.git \
    --exclude=.cursor \
    -cf - . | tar -C "$WORK" -xf -
fi

cd "$WORK"

LOCK_HASH="$(sha256sum package-lock.json | awk '{print $1}')"
if [[ -d node_modules && -f .linux-lockhash && "$(cat .linux-lockhash)" == "$LOCK_HASH" && -x node_modules/electron/dist/electron ]]; then
  echo "Reusing WSL node_modules"
else
  echo "Installing Linux npm dependencies"
  rm -rf node_modules
  npm ci
  printf '%s\n' "$LOCK_HASH" > .linux-lockhash
fi

echo "Building Linux .deb"
npx electron-builder --linux deb --x64

mkdir -p "$SRC/dist"
copied=0
shopt -s nullglob
for f in dist/*.deb dist/latest-linux*.yml dist/*.blockmap; do
  cp -f "$f" "$SRC/dist/"
  copied=1
done

if [[ "$copied" -eq 0 ]]; then
  echo "Linux build finished but no .deb artifacts were found in $WORK/dist" >&2
  ls -la dist || true
  exit 1
fi

echo "Linux artifacts copied to $SRC/dist"
ls -lh "$SRC/dist"/*.deb
