# Kairos Launch Acceptance Checklist (Linux + Docker)

Goal: from empty environment to first bot reply in `<= 15 minutes`, with dual-libc VFS release and runtime selection validated.

## 1. Pre-release checks

- Release tag uses `vfs-v<semver>`, for example `vfs-v0.0.1`.
- Latest release workflow changes are merged to `master`.
- Required environment variables are available:
  - `BOT_TOKEN`
  - `ENCLAVE_API_KEY`
  - `CLOUD_API_KEY`
  - `KAIROS_VFS_VERSION` (recommended for pinned release acceptance; optional in auto-detect mode)

## 2. Build and release checks (GitHub Actions)

1. Trigger `.github/workflows/vfs-binary-release.yml` (tag push or `workflow_dispatch`).
2. Confirm `build` job is green for all targets:
   - `memory-vfs-linux-amd64-musl`
   - `memory-vfs-linux-amd64-gnu`
   - `memory-vfs-linux-arm64-musl`
   - `memory-vfs-linux-arm64-gnu`
3. Confirm `smoke` job is green for Debian + Alpine across amd64 + arm64.
4. Confirm Release assets include:
   - 4 binaries
   - `checksums.txt`
   - `vfs-manifest.json`

## 3. Manifest and checksum checks

Run on any Linux machine (replace values as needed):

```bash
export REPO="vahiru/Yuki-Mochi"
export VER="0.0.1"
export TAG="vfs-v${VER}"
curl -fL "https://github.com/${REPO}/releases/download/${TAG}/vfs-manifest.json" -o /tmp/vfs-manifest.json
curl -fL "https://github.com/${REPO}/releases/download/${TAG}/checksums.txt" -o /tmp/checksums.txt
```

Pass criteria:

- `vfs-manifest.json` has `version == ${VER}`.
- `artifacts` has 4 records, each including `arch`, `libc`, `sha256`, `url`, and `asset_name`.
- `checksums.txt` includes checksum lines for all 4 binaries.

## 4. Runtime selection checks (real deployment)

### 4.1 Standard path (non-developer user)

```bash
cp .env.example .env
export BOT_TOKEN="..."
export ENCLAVE_API_KEY="..."
export CLOUD_API_KEY="..."
export KAIROS_VFS_VERSION="0.0.1"
docker compose up -d --build app
```

Pass criteria:

- Startup succeeds without local Rust/Cargo build.
- `.runtime/bin/vfs-selected.json` exists and includes at least:
  - `version`
  - `arch`
  - `libc`
  - `selected_asset`
  - `verified_sha256`

### 4.2 Auto fallback check (musl -> gnu)

1. Run once on `amd64` with default `auto` strategy and note selected `libc`.
2. Make the first candidate unavailable (remove/corrupt cached candidate binary).
3. Restart app and verify resolver falls back to the next candidate.

Pass criteria:

- Logs show failure reason for first candidate and attempt of next candidate.
- Final selected candidate is written to `.runtime/bin/vfs-selected.json`.
- If both fail, `.runtime/bin/vfs-resolver-error.log` contains actionable recovery hints.

## 5. First reply in 15 minutes

1. Start timer at `docker compose up -d --build app`.
2. Send one message to the bot in Telegram.
3. Stop timer at first bot reply.

Pass criteria:

- `amd64`: `<= 15 minutes`
- `arm64`: `<= 15 minutes`

Recommended record fields:

- machine architecture, CPU, memory
- network condition
- elapsed time
- retry count

## 6. Dashboard status check (optional)

If dashboard is enabled:

```bash
docker compose --profile dashboard up -d dashboard
# GET /api/setup/vfs-binary-status
```

Pass criteria:

- Response includes `version`, `arch`, `libc`, `source`, `checksum`, `last_error`.
- API status matches `.runtime/bin/vfs-selected.json`.

## 7. Rollback plan (must be executable)

- Plan A: set `KAIROS_VFS_VERSION` to previous stable version and restart containers.
- Plan B: place local `.artifacts/memory-vfs` as fallback and restart containers.

Rollback done criteria:

- service starts and stays healthy
- bot can reply
- no crash loop in logs
