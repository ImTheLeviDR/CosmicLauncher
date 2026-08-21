#!/usr/bin/env bash
set -euo pipefail

SRC="${1:?Usage: build-linux.sh <repo-path-in-wsl>}"
WORK="${XDG_CACHE_HOME:-$HOME/.cache}/cosmic-launcher-linux-build"

if [[ ! -d "$SRC" ]]; then
  echo "Source directory does not exist: $SRC" >&2
  exit 1
fi

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
if [[ -d node_modules && -f .linux-lockhash && "$(cat .linux-lockhash)" == "$LOCK_HASH" ]]; then
  echo "Reusing WSL node_modules"
else
  echo "Installing Linux npm dependencies"
  npm ci
  printf '%s\n' "$LOCK_HASH" > .linux-lockhash
fi

echo "Building Linux AppImage"
npx electron-builder --linux AppImage --x64

mkdir -p "$SRC/dist"
copied=0
shopt -s nullglob
for f in dist/*.AppImage dist/*.deb dist/*.tar.gz dist/latest-linux*.yml dist/*.blockmap; do
  cp -f "$f" "$SRC/dist/"
  copied=1
done

if [[ "$copied" -eq 0 ]]; then
  echo "Linux build finished but no artifacts were found in $WORK/dist" >&2
  ls -la dist || true
  exit 1
fi

echo "Linux artifacts copied to $SRC/dist"
ls -lh "$SRC/dist"/*.AppImage "$SRC/dist"/*.deb "$SRC/dist"/*.tar.gz 2>/dev/null || ls -lh "$SRC/dist"
