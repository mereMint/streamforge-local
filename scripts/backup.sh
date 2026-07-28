#!/usr/bin/env bash
#
# Create a complete local backup and optionally upload it with rclone.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
ENV_FILE="$ROOT_DIR/.env"
REMOTE_OVERRIDE=""
LOCAL_ONLY=0

usage() {
  cat <<'EOF'
Usage: bash scripts/backup.sh [--remote REMOTE] [--local-only]

Creates a timestamped .tar.gz containing .env and DATA_DIR. If --remote is
given, or RCLONE_REMOTE is configured in .env, the archive and checksum are
also uploaded with rclone. --local-only disables cloud upload for this run.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

read_env_value() {
  local key="$1"
  local line value=""
  [[ -f "$ENV_FILE" ]] || {
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
  done < "$ENV_FILE"

  printf '%s' "$value"
}

checksum_file() {
  local directory="$1"
  local filename="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$directory" && sha256sum "$filename" > "$filename.sha256")
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$directory" && shasum -a 256 "$filename" > "$filename.sha256")
  else
    die "sha256sum or shasum is required."
  fi
}

while (($#)); do
  case "$1" in
    --remote|--upload)
      (($# >= 2)) || die "$1 requires an rclone destination."
      REMOTE_OVERRIDE="$2"
      shift 2
      ;;
    --local-only)
      LOCAL_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

[[ -f "$ENV_FILE" ]] || die "$ENV_FILE does not exist; run install.sh first."

DATA_SETTING="$(read_env_value "DATA_DIR")"
DATA_SETTING="${DATA_SETTING:-./data}"
if [[ "$DATA_SETTING" == /* ]]; then
  DATA_DIR="$DATA_SETTING"
else
  DATA_DIR="$ROOT_DIR/${DATA_SETTING#./}"
fi
[[ -d "$DATA_DIR" ]] || die "Data directory does not exist: $DATA_DIR"
DATA_DIR="$(cd "$DATA_DIR" && pwd -P)"
case "$DATA_DIR" in
  "/"|"$HOME"|"$ROOT_DIR")
    die "Refusing to back up unsafe DATA_DIR: $DATA_DIR"
    ;;
esac

BACKUP_DIR="${STREAMFORGE_BACKUP_DIR:-$DATA_DIR/backups}"
mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd -P)"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_NAME="streamforge-$TIMESTAMP.tar.gz"
ARCHIVE_PATH="$BACKUP_DIR/$ARCHIVE_NAME"
PARTIAL_PATH="$ARCHIVE_PATH.partial"
[[ ! -e "$ARCHIVE_PATH" && ! -e "$PARTIAL_PATH" ]] ||
  die "A backup with this timestamp already exists: $ARCHIVE_PATH"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/streamforge-backup.XXXXXX")"

cleanup() {
  case "$STAGING_DIR" in
    "${TMPDIR:-/tmp}"/streamforge-backup.*)
      rm -rf -- "$STAGING_DIR"
      ;;
  esac
  rm -f -- "$PARTIAL_PATH"
}
trap cleanup EXIT

mkdir -p "$STAGING_DIR/streamforge-backup/data"
cp -p "$ENV_FILE" "$STAGING_DIR/streamforge-backup/.env"
{
  printf 'format_version=1\n'
  printf 'created_utc=%s\n' "$TIMESTAMP"
  printf 'application=streamforge-local\n'
} > "$STAGING_DIR/streamforge-backup/MANIFEST.txt"

# Local backup archives live below DATA_DIR by default, so omit that directory
# to prevent each new archive from recursively containing all older archives.
tar --exclude='./backups' --exclude='./backups/*' \
  -cf - -C "$DATA_DIR" . |
  tar -xf - -C "$STAGING_DIR/streamforge-backup/data"

tar -czf "$PARTIAL_PATH" -C "$STAGING_DIR" streamforge-backup
mv "$PARTIAL_PATH" "$ARCHIVE_PATH"
checksum_file "$BACKUP_DIR" "$ARCHIVE_NAME"

printf 'Local backup created: %s\n' "$ARCHIVE_PATH"
printf 'Checksum: %s.sha256\n' "$ARCHIVE_PATH"

REMOTE="$REMOTE_OVERRIDE"
if [[ -z "$REMOTE" ]]; then
  REMOTE="$(read_env_value "RCLONE_REMOTE")"
fi

if ((LOCAL_ONLY == 0)) && [[ -n "$REMOTE" ]]; then
  command -v rclone >/dev/null 2>&1 || die "RCLONE_REMOTE is set, but rclone is unavailable."
  if [[ -z "${RCLONE_CONFIG_PASS:-}" ]]; then
    RCLONE_CONFIG_PASS="$(read_env_value "RCLONE_CONFIG_PASS")"
    if [[ -n "$RCLONE_CONFIG_PASS" ]]; then
      export RCLONE_CONFIG_PASS
    fi
  fi
  REMOTE="${REMOTE%/}"
  printf 'Uploading backup to %s/ (archive contents are not printed)\n' "$REMOTE"
  rclone copyto "$ARCHIVE_PATH" "$REMOTE/$ARCHIVE_NAME"
  rclone copyto "$ARCHIVE_PATH.sha256" "$REMOTE/$ARCHIVE_NAME.sha256"
  printf 'Cloud backup uploaded successfully.\n'
elif ((LOCAL_ONLY == 0)); then
  printf 'Cloud upload skipped: RCLONE_REMOTE is not configured.\n'
else
  printf 'Cloud upload skipped for this run.\n'
fi
