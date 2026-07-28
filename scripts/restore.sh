#!/usr/bin/env bash
#
# Restore a specific StreamForge backup. No implicit "latest" selection is
# allowed, which prevents an unattended rollback to the wrong archive.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
ENV_FILE="$ROOT_DIR/.env"
KEEP_ENV=0
ARCHIVE=""
RESTART_SERVICE=0
STAGING_DIR=""

usage() {
  cat <<'EOF'
Usage: bash scripts/restore.sh [--keep-env] /explicit/path/to/backup.tar.gz

Restores the archive's data and, by default, its .env. Existing data and .env
are renamed with a .pre-restore-TIMESTAMP suffix so the operation is recoverable.
Use --keep-env to restore data while retaining the phone's current credentials.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

read_env_value_from() {
  local key="$1"
  local file="$2"
  local line value=""
  [[ -f "$file" ]] || {
    printf ''
    return
  }

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      value="${line#*=}"
      value="${value%$'\r'}"
      if [[ "$value" == \"*\" && "$value" == *\" ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
        value="${value:1:${#value}-2}"
      fi
      break
    fi
  done < "$file"

  printf '%s' "$value"
}

cleanup() {
  if [[ -n "$STAGING_DIR" ]]; then
    case "$STAGING_DIR" in
      "${TMPDIR:-/tmp}"/streamforge-restore.*)
        rm -rf -- "$STAGING_DIR"
        ;;
    esac
  fi

  if ((RESTART_SERVICE == 1)) && command -v sv >/dev/null 2>&1; then
    sv up streamforge >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

while (($#)); do
  case "$1" in
    --keep-env)
      KEEP_ENV=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      die "Unknown argument: $1"
      ;;
    *)
      [[ -z "$ARCHIVE" ]] || die "Pass exactly one backup archive."
      ARCHIVE="$1"
      shift
      ;;
  esac
done

[[ -n "$ARCHIVE" ]] || {
  usage >&2
  die "An explicit backup archive is required."
}
[[ -f "$ARCHIVE" ]] || die "Backup archive not found: $ARCHIVE"
ARCHIVE_DIR="$(cd -- "$(dirname -- "$ARCHIVE")" && pwd -P)"
ARCHIVE="$ARCHIVE_DIR/$(basename -- "$ARCHIVE")"

CHECKSUM_PATH="$ARCHIVE.sha256"
if [[ -f "$CHECKSUM_PATH" ]]; then
  printf 'Verifying checksum...\n'
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$ARCHIVE_DIR" && sha256sum -c "$(basename "$CHECKSUM_PATH")")
  elif command -v shasum >/dev/null 2>&1; then
    EXPECTED="$(awk '{print $1; exit}' "$CHECKSUM_PATH")"
    ACTUAL="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
    [[ "$EXPECTED" == "$ACTUAL" ]] || die "Backup checksum does not match."
  else
    die "A checksum file exists, but sha256sum/shasum is unavailable."
  fi
else
  printf 'Warning: no adjacent checksum file was found; only restore trusted archives.\n' >&2
fi

# Reject absolute paths, traversal, and unexpected top-level entries before
# asking tar to extract anything.
while IFS= read -r entry; do
  [[ "$entry" != /* ]] || die "Archive contains an absolute path."
  [[ "$entry" != *\\* ]] || die "Archive contains a non-portable path."
  clean_entry="${entry#./}"
  case "/$clean_entry/" in
    *"/../"*) die "Archive contains a parent-directory traversal." ;;
  esac
  case "$clean_entry" in
    streamforge-backup|streamforge-backup/*) ;;
    *) die "Archive has an unexpected top-level entry: $entry" ;;
  esac
done < <(tar -tzf "$ARCHIVE")

STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/streamforge-restore.XXXXXX")"
tar -xzf "$ARCHIVE" -C "$STAGING_DIR"
PAYLOAD="$STAGING_DIR/streamforge-backup"

[[ -f "$PAYLOAD/MANIFEST.txt" && ! -L "$PAYLOAD/MANIFEST.txt" ]] ||
  die "Backup manifest is missing or invalid."
grep -q '^format_version=1$' "$PAYLOAD/MANIFEST.txt" ||
  die "Unsupported backup format."
[[ -d "$PAYLOAD/data" && ! -L "$PAYLOAD/data" ]] ||
  die "Backup data directory is missing or invalid."
if ((KEEP_ENV == 0)); then
  [[ -f "$PAYLOAD/.env" && ! -L "$PAYLOAD/.env" ]] ||
    die "Backup .env is missing or invalid; use --keep-env only if intentional."
fi

if ((KEEP_ENV == 1)); then
  DATA_SOURCE_ENV="$ENV_FILE"
else
  DATA_SOURCE_ENV="$PAYLOAD/.env"
fi
[[ -f "$DATA_SOURCE_ENV" ]] ||
  die "No environment file is available to resolve DATA_DIR."
DATA_SETTING="$(read_env_value_from "DATA_DIR" "$DATA_SOURCE_ENV")"
DATA_SETTING="${DATA_SETTING:-./data}"
if [[ "$DATA_SETTING" == /* ]]; then
  DATA_DIR="$DATA_SETTING"
else
  DATA_DIR="$ROOT_DIR/${DATA_SETTING#./}"
fi
DATA_DIR="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$DATA_DIR")"

case "$DATA_DIR" in
  "/"|"$HOME"|"$ROOT_DIR")
    die "Refusing to restore into unsafe DATA_DIR: $DATA_DIR"
    ;;
esac

if command -v sv >/dev/null 2>&1 &&
   sv status streamforge 2>/dev/null | grep -q '^run:'; then
  printf 'Stopping StreamForge for a consistent restore...\n'
  sv down streamforge
  RESTART_SERVICE=1
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OLD_DATA=""
if [[ -e "$DATA_DIR" ]]; then
  [[ ! -L "$DATA_DIR" ]] || die "Refusing to replace a symlinked DATA_DIR."
  OLD_DATA="$DATA_DIR.pre-restore-$TIMESTAMP"
  mv "$DATA_DIR" "$OLD_DATA"
fi

mkdir -p "$DATA_DIR"
if ! cp -a "$PAYLOAD/data/." "$DATA_DIR/"; then
  FAILED_DATA="$DATA_DIR.failed-$TIMESTAMP"
  mv "$DATA_DIR" "$FAILED_DATA" 2>/dev/null || true
  if [[ -n "$OLD_DATA" ]]; then
    mv "$OLD_DATA" "$DATA_DIR" 2>/dev/null || true
  fi
  die "Data copy failed. Any partial restore is at $FAILED_DATA."
fi

OLD_ENV=""
if ((KEEP_ENV == 0)); then
  if [[ -f "$ENV_FILE" ]]; then
    OLD_ENV="$ENV_FILE.pre-restore-$TIMESTAMP"
    cp -p "$ENV_FILE" "$OLD_ENV"
  fi
  ENV_TMP="$(mktemp "${ENV_FILE}.restore.XXXXXX")"
  cp "$PAYLOAD/.env" "$ENV_TMP"
  chmod 600 "$ENV_TMP"
  mv "$ENV_TMP" "$ENV_FILE"
fi

if ((RESTART_SERVICE == 1)); then
  printf 'Starting StreamForge...\n'
  sv up streamforge
  sv status streamforge 2>/dev/null | grep -q '^run:' ||
    die "Data was restored, but StreamForge did not return to the running state."
  RESTART_SERVICE=0
fi

printf 'Restore complete from: %s\n' "$ARCHIVE"
if [[ -n "$OLD_DATA" ]]; then
  printf 'Previous data retained at: %s\n' "$OLD_DATA"
fi
if [[ -n "$OLD_ENV" ]]; then
  printf 'Previous environment retained at: %s\n' "$OLD_ENV"
fi
if ((KEEP_ENV == 1)); then
  printf 'Current .env retained (--keep-env).\n'
fi
