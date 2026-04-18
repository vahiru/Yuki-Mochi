#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
EXAMPLE_FILE="${ROOT_DIR}/.env.example"

if ! command -v docker >/dev/null 2>&1; then
  echo "[deploy-wizard] docker is required." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[deploy-wizard] docker compose is required." >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ -f "${EXAMPLE_FILE}" ]]; then
    cp "${EXAMPLE_FILE}" "${ENV_FILE}"
    echo "[deploy-wizard] created .env from .env.example"
  else
    touch "${ENV_FILE}"
    echo "[deploy-wizard] created empty .env"
  fi
fi

get_env_value() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "${ENV_FILE}" | tail -n1 || true)"
  if [[ -z "${line}" ]]; then
    echo ""
    return
  fi
  # Trim CR from CRLF files.
  printf '%s' "${line#*=}" | tr -d '\r'
}

upsert_env() {
  local key="$1"
  local value="$2"
  if [[ "${value}" == *$'\n'* ]]; then
    echo "[deploy-wizard] ${key} contains newline, unsupported." >&2
    exit 1
  fi

  local tmp
  tmp="$(mktemp)"
  awk -v key="${key}" -v value="${value}" '
    BEGIN { replaced = 0 }
    $0 ~ ("^" key "=") {
      if (replaced == 0) {
        print key "=" value
        replaced = 1
      }
      next
    }
    { print }
    END {
      if (replaced == 0) {
        print key "=" value
      }
    }
  ' "${ENV_FILE}" > "${tmp}"
  mv "${tmp}" "${ENV_FILE}"
}

prompt_value() {
  local label="$1"
  local default="$2"
  local secret="${3:-false}"
  local value=""

  if [[ "${secret}" == "true" ]]; then
    if [[ -n "${default}" ]]; then
      read -r -s -p "${label} [keep current if empty]: " value
    else
      read -r -s -p "${label}: " value
    fi
    # Keep this on stderr so command substitution does not capture it.
    printf '\n' >&2
  else
    if [[ -n "${default}" ]]; then
      read -r -p "${label} [${default}]: " value
    else
      read -r -p "${label}: " value
    fi
  fi

  if [[ -z "${value}" ]]; then
    value="${default}"
  fi
  # Normalize accidental CR/LF from paste/default values.
  value="$(printf '%s' "${value}" | tr -d '\r\n')"
  printf '%s\n' "${value}"
}

prompt_required() {
  local label="$1"
  local default="$2"
  local secret="${3:-false}"
  local value=""
  while true; do
    value="$(prompt_value "${label}" "${default}" "${secret}")"
    if [[ -n "${value}" ]]; then
      echo "${value}"
      return
    fi
    echo "[deploy-wizard] ${label} is required."
  done
}

echo "==============================================="
echo " Kairos Deploy Wizard"
echo "==============================================="
echo "This wizard updates .env and starts docker compose."
echo

mode_default="$(get_env_value "TELEGRAM_MODE")"
if [[ -z "${mode_default}" ]]; then
  mode_default="bot"
fi

while true; do
  mode="$(prompt_value "Telegram mode (bot/userbot)" "${mode_default}")"
  case "${mode}" in
    bot|userbot) break ;;
    *) echo "[deploy-wizard] please input bot or userbot." ;;
  esac
done

upsert_env "TELEGRAM_MODE" "${mode}"

if [[ "${mode}" == "bot" ]]; then
  bot_token_default="$(get_env_value "BOT_TOKEN")"
  bot_token="$(prompt_required "BOT_TOKEN" "${bot_token_default}" "true")"
  upsert_env "BOT_TOKEN" "${bot_token}"
else
  api_id_default="$(get_env_value "TELEGRAM_API_ID")"
  api_hash_default="$(get_env_value "TELEGRAM_API_HASH")"
  phone_default="$(get_env_value "TELEGRAM_PHONE")"
  session_default="$(get_env_value "TELEGRAM_SESSION_STRING")"

  tg_api_id="$(prompt_required "TELEGRAM_API_ID" "${api_id_default}")"
  tg_api_hash="$(prompt_required "TELEGRAM_API_HASH" "${api_hash_default}" "true")"
  tg_phone="$(prompt_required "TELEGRAM_PHONE" "${phone_default}")"
  tg_session="$(prompt_value "TELEGRAM_SESSION_STRING (optional)" "${session_default}" "true")"

  upsert_env "TELEGRAM_API_ID" "${tg_api_id}"
  upsert_env "TELEGRAM_API_HASH" "${tg_api_hash}"
  upsert_env "TELEGRAM_PHONE" "${tg_phone}"
  upsert_env "TELEGRAM_SESSION_STRING" "${tg_session}"
fi

owner_default="$(get_env_value "OWNER_USER_ID")"
owner_user_id="$(prompt_value "OWNER_USER_ID (optional but recommended)" "${owner_default}")"
upsert_env "OWNER_USER_ID" "${owner_user_id}"

api_key_default="$(get_env_value "API_KEY")"
api_key="$(prompt_required "API_KEY (main LLM key)" "${api_key_default}" "true")"
upsert_env "API_KEY" "${api_key}"

base_url_default="$(get_env_value "BASE_URL")"
if [[ -z "${base_url_default}" ]]; then
  base_url_default="https://api.deepseek.com/v1"
fi
base_url="$(prompt_required "BASE_URL" "${base_url_default}")"
upsert_env "BASE_URL" "${base_url}"

model_default="$(get_env_value "MODEL")"
if [[ -z "${model_default}" ]]; then
  model_default="deepseek-chat"
fi
model="$(prompt_required "MODEL" "${model_default}")"
upsert_env "MODEL" "${model}"

cloud_key_default="$(get_env_value "STATE_DAEMON_CLOUD_API_KEY")"
cloud_key="$(prompt_value "STATE_DAEMON_CLOUD_API_KEY (optional)" "${cloud_key_default}" "true")"
upsert_env "STATE_DAEMON_CLOUD_API_KEY" "${cloud_key}"

vfs_version_default="$(get_env_value "KAIROS_VFS_VERSION")"
vfs_version="$(prompt_value "KAIROS_VFS_VERSION (optional, blank = auto-detect latest)" "${vfs_version_default}")"
if [[ "${vfs_version}" == "auto" ]]; then
  vfs_version=""
fi
upsert_env "KAIROS_VFS_VERSION" "${vfs_version}"

strategy_default="$(get_env_value "KAIROS_VFS_BIN_STRATEGY")"
if [[ -z "${strategy_default}" ]]; then
  strategy_default="auto"
fi
while true; do
  strategy="$(prompt_value "KAIROS_VFS_BIN_STRATEGY (auto/musl/gnu)" "${strategy_default}")"
  case "${strategy}" in
    auto|musl|gnu) break ;;
    *) echo "[deploy-wizard] please input auto, musl, or gnu." ;;
  esac
done
upsert_env "KAIROS_VFS_BIN_STRATEGY" "${strategy}"

dashboard_choice="$(prompt_value "Start dashboard too? (y/N)" "N")"

echo
echo "[deploy-wizard] .env updated."
echo "[deploy-wizard] starting containers..."

if [[ "${dashboard_choice}" =~ ^[Yy]$ ]]; then
  docker compose --profile dashboard up -d --build app dashboard
else
  docker compose up -d --build app
fi

echo
echo "Deployment started."
echo
echo "Useful checks:"
echo "  docker compose ps"
echo "  docker compose logs --tail=120 app"
echo "  cat .runtime/bin/vfs-selected.json"
echo "  cat .runtime/bin/vfs-resolver-error.log"

