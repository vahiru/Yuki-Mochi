#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_FALLBACK="/opt/artifacts/memory-vfs"
BIN_DIR="${KAIROS_VFS_BIN_DIR:-${ROOT_DIR}/.runtime/bin}"
STATUS_FILE="${BIN_DIR}/vfs-selected.json"
ERROR_LOG="${BIN_DIR}/vfs-resolver-error.log"
SELECTED_LINK="${BIN_DIR}/memory-vfs-selected"
VFS_REPO="${KAIROS_VFS_REPO:-vahiru/Yuki-Mochi}"
LAST_FAILURE=""
PROBE_FAILURE_REASON=""

mkdir -p "${BIN_DIR}"
touch "${ERROR_LOG}"

log() {
  echo "[vfs-resolver] $*" >&2
}

append_error() {
  local msg="$1"
  LAST_FAILURE="$msg"
  printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$msg" >> "${ERROR_LOG}"
}

set_selected_binary() {
  local src="$1"
  if ln -sf "${src}" "${SELECTED_LINK}" 2>/dev/null; then
    return 0
  fi
  cp "${src}" "${SELECTED_LINK}"
  chmod +x "${SELECTED_LINK}"
}

resolve_arch() {
  if [[ -n "${KAIROS_VFS_ARCH:-}" ]]; then
    case "${KAIROS_VFS_ARCH}" in
      amd64|arm64)
        echo "${KAIROS_VFS_ARCH}"
        return
        ;;
      *)
        append_error "invalid KAIROS_VFS_ARCH=${KAIROS_VFS_ARCH}, expected amd64|arm64"
        return 1
        ;;
    esac
  fi

  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *)
      append_error "unsupported machine architecture: $(uname -m)"
      return 1
      ;;
  esac
}

resolve_strategy() {
  local strategy="${KAIROS_VFS_BIN_STRATEGY:-auto}"
  case "${strategy}" in
    auto|musl|gnu) echo "${strategy}" ;;
    *)
      append_error "invalid KAIROS_VFS_BIN_STRATEGY=${strategy}, expected auto|musl|gnu"
      return 1
      ;;
  esac
}

curl_json() {
  local url="$1"
  local output="$2"

  local auth_token="${KAIROS_VFS_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"
  local curl_args=(
    -fsSL
    --retry 3
    --retry-all-errors
    -H "Accept: application/vnd.github+json"
    -H "User-Agent: kairos-vfs-resolver"
  )
  if [[ -n "${auth_token}" ]]; then
    curl_args+=(-H "Authorization: Bearer ${auth_token}")
  fi

  curl "${curl_args[@]}" "${url}" -o "${output}"
}

discover_latest_vfs_release() {
  local releases_api="${KAIROS_VFS_RELEASES_API_URL:-https://api.github.com/repos/${VFS_REPO}/releases?per_page=30}"
  local releases_json="${BIN_DIR}/github-releases.json"

  if ! curl_json "${releases_api}" "${releases_json}"; then
    append_error "failed to query GitHub releases API: ${releases_api}"
    return 1
  fi

  python3 - "${releases_json}" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

if isinstance(data, dict):
    if "message" in data:
        print(data["message"], file=sys.stderr)
        sys.exit(2)
    data = [data]

def is_vfs_release(item):
    tag = str(item.get("tag_name", ""))
    if not tag.startswith("vfs-v"):
        return False
    if item.get("draft"):
        return False
    return True

stable = [r for r in data if is_vfs_release(r) and not r.get("prerelease")]
fallback = [r for r in data if is_vfs_release(r)]
candidates = stable if stable else fallback

if not candidates:
    sys.exit(1)

tag = str(candidates[0].get("tag_name", ""))
version = tag[len("vfs-v"):]
if not version:
    sys.exit(1)

print(f"{tag}\t{version}")
PY
}

read_manifest_metadata() {
  local manifest_path="$1"
  python3 - "${manifest_path}" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

version = str(data.get("version", "") or "")
release_tag = str(data.get("release_tag", "") or "")
print(f"{version}\t{release_tag}")
PY
}

probe_binary() {
  local binary_path="$1"
  local probe_root
  probe_root="$(mktemp -d "${TMPDIR:-/tmp}/kairos-vfs-probe.XXXXXX")"
  local probe_socket="${probe_root}/probe.sock"
  local probe_log="${probe_root}/probe.log"
  local pid=""
  local ok=0

  mkdir -p \
    "${probe_root}/entities" \
    "${probe_root}/memory" \
    "${probe_root}/sandbox" \
    "${probe_root}/proc-store" \
    "${probe_root}/svc-store"

  SANDBOX_MODE=host \
  VFS_USERS_ROOT="${probe_root}/entities" \
  VFS_MEMORY_ROOT="${probe_root}/memory" \
  VFS_SYSTEM_DB="${probe_root}/system.db" \
  VFS_SANDBOX_ROOT="${probe_root}/sandbox" \
  VFS_PROC_STORE_ROOT="${probe_root}/proc-store" \
  VFS_SVC_STORE_ROOT="${probe_root}/svc-store" \
  VFS_LISTEN="unix://${probe_socket}" \
  "${binary_path}" >"${probe_log}" 2>&1 &
  pid=$!

  for _ in $(seq 1 80); do
    if [[ -S "${probe_socket}" ]]; then
      ok=1
      break
    fi
    if ! kill -0 "${pid}" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  kill "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null || true

  if [[ "${ok}" -eq 1 ]]; then
    rm -rf "${probe_root}"
    return 0
  fi

  PROBE_FAILURE_REASON="$(tail -n 50 "${probe_log}" 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
  if [[ -z "${PROBE_FAILURE_REASON}" ]]; then
    PROBE_FAILURE_REASON="probe failed without log output"
  fi
  rm -rf "${probe_root}"
  return 1
}

write_status_ready() {
  local source="$1"
  local version="$2"
  local release_tag="$3"
  local arch="$4"
  local strategy="$5"
  local libc="$6"
  local selected_binary="$7"
  local asset_name="$8"
  local asset_url="$9"
  local sha256="${10}"
  local manifest_url="${11}"

  STATUS_SOURCE="${source}" \
  STATUS_VERSION="${version}" \
  STATUS_RELEASE_TAG="${release_tag}" \
  STATUS_ARCH="${arch}" \
  STATUS_STRATEGY="${strategy}" \
  STATUS_LIBC="${libc}" \
  STATUS_SELECTED_BINARY="${selected_binary}" \
  STATUS_ASSET_NAME="${asset_name}" \
  STATUS_ASSET_URL="${asset_url}" \
  STATUS_SHA256="${sha256}" \
  STATUS_MANIFEST_URL="${manifest_url}" \
  STATUS_LAST_FAILURE="${LAST_FAILURE}" \
  STATUS_ERROR_LOG="${ERROR_LOG}" \
  python3 - "${STATUS_FILE}" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path = sys.argv[1]
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

data = {
    "status": "ready",
    "selected_at": now,
    "source": os.environ["STATUS_SOURCE"],
    "version": os.environ["STATUS_VERSION"],
    "release_tag": os.environ["STATUS_RELEASE_TAG"],
    "arch": os.environ["STATUS_ARCH"],
    "strategy": os.environ["STATUS_STRATEGY"],
    "libc": os.environ["STATUS_LIBC"],
    "selected_binary_path": os.environ["STATUS_SELECTED_BINARY"],
    "asset_name": os.environ["STATUS_ASSET_NAME"],
    "url": os.environ["STATUS_ASSET_URL"],
    "sha256": os.environ["STATUS_SHA256"],
    "manifest_url": os.environ["STATUS_MANIFEST_URL"],
    "last_failure": os.environ.get("STATUS_LAST_FAILURE", ""),
    "error_log": os.environ["STATUS_ERROR_LOG"],
  }

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
}

write_status_failed() {
  local version="$1"
  local release_tag="$2"
  local arch="$3"
  local strategy="$4"
  local manifest_url="$5"
  local message="$6"

  STATUS_VERSION="${version}" \
  STATUS_RELEASE_TAG="${release_tag}" \
  STATUS_ARCH="${arch}" \
  STATUS_STRATEGY="${strategy}" \
  STATUS_MANIFEST_URL="${manifest_url}" \
  STATUS_LAST_FAILURE="${message}" \
  STATUS_ERROR_LOG="${ERROR_LOG}" \
  python3 - "${STATUS_FILE}" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

path = sys.argv[1]
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

data = {
    "status": "failed",
    "updated_at": now,
    "source": "resolver",
    "version": os.environ["STATUS_VERSION"],
    "release_tag": os.environ["STATUS_RELEASE_TAG"],
    "arch": os.environ["STATUS_ARCH"],
    "strategy": os.environ["STATUS_STRATEGY"],
    "manifest_url": os.environ["STATUS_MANIFEST_URL"],
    "last_failure": os.environ["STATUS_LAST_FAILURE"],
    "error_log": os.environ["STATUS_ERROR_LOG"],
  }

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
}

if [[ -x "${LOCAL_FALLBACK}" ]]; then
  set_selected_binary "${LOCAL_FALLBACK}"
  arch="$(resolve_arch || true)"
  strategy="$(resolve_strategy || true)"
  write_status_ready \
    "local-fallback" \
    "local" \
    "local" \
    "${arch:-unknown}" \
    "${strategy:-auto}" \
    "unknown" \
    "${SELECTED_LINK}" \
    "$(basename "${LOCAL_FALLBACK}")" \
    "file://${LOCAL_FALLBACK}" \
    "n/a" \
    "n/a"
  log "using local fallback binary: ${LOCAL_FALLBACK}"
  echo "${SELECTED_LINK}"
  exit 0
fi

arch="$(resolve_arch)" || {
  write_status_failed "unknown" "unknown" "unknown" "unknown" "n/a" "${LAST_FAILURE}"
  exit 1
}
strategy="$(resolve_strategy)" || {
  write_status_failed "unknown" "unknown" "${arch}" "unknown" "n/a" "${LAST_FAILURE}"
  exit 1
}

version="${KAIROS_VFS_VERSION:-}"
release_tag=""
if [[ -n "${version}" ]]; then
  release_tag="vfs-v${version}"
fi

manifest_url="${KAIROS_VFS_MANIFEST_URL:-}"
if [[ -z "${manifest_url}" && -z "${release_tag}" ]]; then
  discovered=""
  if ! discovered="$(discover_latest_vfs_release)"; then
    append_error "failed to auto-detect latest vfs-v* release; set KAIROS_VFS_VERSION or KAIROS_VFS_MANIFEST_URL explicitly"
    write_status_failed "auto" "auto" "${arch}" "${strategy}" "n/a" "${LAST_FAILURE}"
    exit 1
  fi
  IFS=$'\t' read -r release_tag version <<< "${discovered}"
  log "auto-detected VFS release: ${release_tag}"
fi

if [[ -z "${manifest_url}" ]]; then
  manifest_url="https://github.com/${VFS_REPO}/releases/download/${release_tag}/vfs-manifest.json"
fi

manifest_cache_key="${version:-${release_tag:-custom}}"
manifest_cache_key="$(echo "${manifest_cache_key}" | tr -c 'A-Za-z0-9._-' '_')"
MANIFEST_PATH="${BIN_DIR}/vfs-manifest-${manifest_cache_key}.json"

if ! curl -fsSL --retry 3 --retry-all-errors "${manifest_url}" -o "${MANIFEST_PATH}"; then
  append_error "failed to download manifest: ${manifest_url}"
  write_status_failed "${version:-unknown}" "${release_tag:-unknown}" "${arch}" "${strategy}" "${manifest_url}" "${LAST_FAILURE}"
  exit 1
fi

manifest_meta="$(read_manifest_metadata "${MANIFEST_PATH}" || true)"
if [[ -n "${manifest_meta}" ]]; then
  IFS=$'\t' read -r manifest_version manifest_release_tag <<< "${manifest_meta}"
  if [[ -n "${manifest_version}" ]]; then
    version="${manifest_version}"
  fi
  if [[ -n "${manifest_release_tag}" ]]; then
    release_tag="${manifest_release_tag}"
  fi
fi

if [[ -z "${version}" ]]; then
  version="unknown"
fi
if [[ -z "${release_tag}" ]]; then
  release_tag="unknown"
fi

mapfile -t candidates < <(
  python3 - "${MANIFEST_PATH}" "${arch}" "${strategy}" <<'PY'
import json
import sys

manifest_path, arch, strategy = sys.argv[1], sys.argv[2], sys.argv[3]
with open(manifest_path, "r", encoding="utf-8") as f:
    data = json.load(f)

order = {
    "auto": ["musl", "gnu"],
    "musl": ["musl"],
    "gnu": ["gnu"],
}[strategy]

artifacts = data.get("artifacts", [])
for libc in order:
    hit = None
    for item in artifacts:
        if item.get("arch") == arch and item.get("libc") == libc:
            hit = item
            break
    if not hit:
        continue
    print(
        "\t".join(
            [
                libc,
                str(hit.get("asset_name", "")),
                str(hit.get("url", "")),
                str(hit.get("sha256", "")),
            ]
        )
    )
PY
)

if [[ "${#candidates[@]}" -eq 0 ]]; then
  append_error "manifest has no candidate for arch=${arch}, strategy=${strategy}"
  write_status_failed "${version}" "${release_tag}" "${arch}" "${strategy}" "${manifest_url}" "${LAST_FAILURE}"
  exit 1
fi

for row in "${candidates[@]}"; do
  IFS=$'\t' read -r libc asset_name asset_url expected_sha <<< "${row}"

  if [[ -z "${asset_name}" || -z "${asset_url}" || -z "${expected_sha}" ]]; then
    append_error "invalid manifest row for libc=${libc}"
    continue
  fi

  local_path="${BIN_DIR}/${asset_name}"

  if [[ ! -x "${local_path}" ]]; then
    if ! curl -fsSL --retry 3 --retry-all-errors "${asset_url}" -o "${local_path}"; then
      append_error "download failed for ${asset_name} (${asset_url})"
      rm -f "${local_path}"
      continue
    fi
    chmod +x "${local_path}"
  fi

  actual_sha="$(sha256sum "${local_path}" | awk '{print $1}')"
  if [[ "${actual_sha}" != "${expected_sha}" ]]; then
    append_error "checksum mismatch for ${asset_name}: expected=${expected_sha} actual=${actual_sha}"
    rm -f "${local_path}"
    continue
  fi

  if ! probe_binary "${local_path}"; then
    append_error "probe failed for ${asset_name}: ${PROBE_FAILURE_REASON}"
    continue
  fi

  set_selected_binary "${local_path}"
  write_status_ready \
    "github-release" \
    "${version}" \
    "${release_tag}" \
    "${arch}" \
    "${strategy}" \
    "${libc}" \
    "${SELECTED_LINK}" \
    "${asset_name}" \
    "${asset_url}" \
    "${expected_sha}" \
    "${manifest_url}"
  log "selected binary ${asset_name} (${libc})"
  echo "${SELECTED_LINK}"
  exit 0
done

append_error "all VFS candidates failed for arch=${arch}, strategy=${strategy}, version=${version}"
write_status_failed "${version}" "${release_tag}" "${arch}" "${strategy}" "${manifest_url}" "${LAST_FAILURE}"
exit 1
