#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="$ROOT_DIR/engine"
SHELL_DIR="$ROOT_DIR/shell"
RENDERER_DIR="$ROOT_DIR/renderer"
SIDECAR_PLATFORM="${SIDECAR_PLATFORM:-linux}"
SIDECAR_RESOURCE_DIR="$SHELL_DIR/resources/sidecar/$SIDECAR_PLATFORM"

NODE_ENV=development npm --prefix "$RENDERER_DIR" run build
NODE_ENV=development npm --prefix "$SHELL_DIR" run build

(cd "$ENGINE_DIR" && .venv/bin/pyinstaller --clean --noconfirm photodedup-sidecar.spec --distpath dist --workpath build)
rm -rf "$SIDECAR_RESOURCE_DIR/photodedup-sidecar"
mkdir -p "$SIDECAR_RESOURCE_DIR"
cp -a "$ENGINE_DIR/dist/photodedup-sidecar" "$SIDECAR_RESOURCE_DIR/"

(cd "$SHELL_DIR" && NODE_ENV=development npx electron-builder --linux --arm64 --dir)
