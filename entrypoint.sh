#!/bin/bash
set -euo pipefail
export PATH=/root/.bun/bin:$PATH

echo '[app] Starting bun install...'
bun install --frozen-lockfile || bun install

vfs_bin='/opt/artifacts/memory-vfs'
vfs_socket='/run/kairos-runtime/sockets/kairos-runtime-vfs.sock'
resolver='/workspace/scripts/resolve-vfs-binary.sh'

if [ ! -x "$vfs_bin" ]; then
  if [ ! -f "$resolver" ]; then
    echo "[app] Error: missing resolver script at $resolver"
    exit 1
  fi
  echo '[app] Resolving VFS binary from GitHub Release assets...'
  if ! vfs_bin="$(bash "$resolver")"; then
    echo '[app] Error: VFS binary resolution failed.'
    echo '[app] Hint: pin KAIROS_VFS_VERSION, or use auto-detect latest release, or provide local fallback .artifacts/memory-vfs'
    exit 1
  fi
  # Normalize resolver output to avoid hidden CR/LF or relative-path surprises.
  vfs_bin="$(printf '%s' "$vfs_bin" | tr -d '\r\n')"
  case "$vfs_bin" in
    /*) ;;
    *) vfs_bin="/workspace/${vfs_bin#./}" ;;
  esac
  if [ ! -x "$vfs_bin" ]; then
    echo "[app] Error: resolved VFS binary is not executable: $vfs_bin"
    ls -la /workspace/.runtime/bin || true
    exit 1
  fi
  echo "[app] Selected VFS binary: $vfs_bin"
fi

echo "[app] Starting memory-vfs with socket $vfs_socket..."
mkdir -p /run/kairos-runtime/sockets
rm -f "$vfs_socket"

export MEMORY_VFS_TARGET="$vfs_socket"
export KAIROS_VFS_SOCKET="$vfs_socket"
export VFS_USERS_ROOT="${VFS_USERS_ROOT:-/workspace/src/vfs/data/state/entities}"
export VFS_MEMORY_ROOT="${VFS_MEMORY_ROOT:-/workspace/src/vfs/data/state/memory}"
export VFS_SYSTEM_DB="${VFS_SYSTEM_DB:-/workspace/src/vfs/data/state/system.db}"
export VFS_SANDBOX_ROOT="${VFS_SANDBOX_ROOT:-/workspace/src/vfs/data/state/sandbox}"
export VFS_PROC_STORE_ROOT="${VFS_PROC_STORE_ROOT:-/workspace/src/vfs/data/state/proc-store}"
export VFS_SVC_STORE_ROOT="${VFS_SVC_STORE_ROOT:-/workspace/src/vfs/data/state/svc-store}"
export OLLAMA_URL="${OLLAMA_URL:-${OLLAMA_BASE_URL:-http://127.0.0.1:11434}}"
export EMBED_MODEL="${EMBED_MODEL:-${OLLAMA_EMBED_MODEL:-qwen3-embedding:0.6b}}"

export VFS_LISTEN="unix://$vfs_socket" && "$vfs_bin" &
vfs_pid=$!

for i in {1..120}; do
  if [ -S "$vfs_socket" ]; then
    echo '[app] memory-vfs ready'
    break
  fi
  if [ -S "/tmp/kairos-runtime-vfs.sock" ]; then
    echo '[app] memory-vfs started at legacy path /tmp/kairos-runtime-vfs.sock, linking...'
    ln -sf /tmp/kairos-runtime-vfs.sock "$vfs_socket"
    break
  fi
  if ! kill -0 $vfs_pid 2>/dev/null; then
    echo '[app] memory-vfs process died'
    exit 1
  fi
  sleep 1
done

echo '[app] Starting application...'
bun run dev
