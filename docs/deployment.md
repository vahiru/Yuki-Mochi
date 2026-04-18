# Deployment Guide (Linux + Docker)

Launch acceptance checklist: `docs/launch-acceptance-checklist.md`

## Quick Start

Set required env vars:

```bash
cp .env.example .env

# required
export BOT_TOKEN="your_telegram_bot_token"
export ENCLAVE_API_KEY="your_llm_api_key"
export CLOUD_API_KEY="your_llm_api_key"
export KAIROS_VFS_VERSION="1.0.0"
```

Start app:

```bash
docker compose up -d --build app
```

## VFS Binary Resolution

The runtime resolves VFS binary from GitHub Release assets when local fallback is missing:

- `memory-vfs-linux-amd64-musl`
- `memory-vfs-linux-amd64-gnu`
- `memory-vfs-linux-arm64-musl`
- `memory-vfs-linux-arm64-gnu`

Resolver defaults:

- `KAIROS_VFS_BIN_STRATEGY=auto` (`musl -> gnu`)
- `KAIROS_VFS_ARCH` auto-detected by `uname -m`
- `KAIROS_VFS_BIN_DIR=.runtime/bin`

Status files:

- `.runtime/bin/vfs-selected.json`
- `.runtime/bin/vfs-resolver-error.log`

## Developer Fallback

If you prefer host-built binary, place it at `.artifacts/memory-vfs`:

```bash
bash scripts/build-vfs.sh --release
docker compose up -d --build app
```

This path is intended for developers; end users do not need Rust/Cargo installed locally.
