#!/usr/bin/env bash
#
# StreamForge Local phone-first installer.
# Safe to run again: it preserves configured secrets and refuses to pull over
# local source changes.

set -Eeuo pipefail
umask 077

REPO_SLUG="${STREAMFORGE_REPO:-mereMint/streamforge-local}"
BRANCH="${STREAMFORGE_BRANCH:-main}"
INSTALL_DIR="${STREAMFORGE_HOME:-$HOME/streamforge-local}"
SERVICE_NAME="streamforge"

info() {
  printf '\n==> %s\n' "$*"
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

is_termux() {
  [[ -n "${TERMUX_VERSION:-}" || "${PREFIX:-}" == *com.termux* ]]
}

require_safe_install_dir() {
  case "$INSTALL_DIR" in
    ""|"/"|"$HOME")
      die "STREAMFORGE_HOME must name a dedicated directory, not '$INSTALL_DIR'."
      ;;
  esac

  if [[ "$INSTALL_DIR" == *$'\n'* || "$INSTALL_DIR" == *"'"* ]]; then
    die "The install path cannot contain a newline or single quote."
  fi
}

install_termux_packages() {
  info "Installing the small native Termux runtime"
  command -v pkg >/dev/null 2>&1 || die "Termux was detected, but pkg is unavailable."
  pkg install -y nodejs-lts git openssh termux-services rclone gh
}

check_linux_runtime() {
  local missing=()
  local command_name

  for command_name in node npm git; do
    command -v "$command_name" >/dev/null 2>&1 || missing+=("$command_name")
  done

  if ((${#missing[@]})); then
    printf 'Missing Linux prerequisites: %s\n' "${missing[*]}" >&2
    printf '%s\n' \
      "The generic Linux installer is intentionally not changing system packages yet." \
      "Install Node.js 22.12+, npm, and Git, then run install.sh again." >&2
    exit 1
  fi

  warn "Generic Linux support is preliminary; this release is tested for unrooted Termux first."
}

check_node_version() {
  node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1);
  ' || die "Node.js 22.12 or newer is required; found $(node --version)."
}

clone_or_update() {
  if [[ -e "$INSTALL_DIR" && ! -d "$INSTALL_DIR" ]]; then
    die "$INSTALL_DIR exists and is not a directory."
  fi

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Using the existing checkout at $INSTALL_DIR"

    local origin_url
    origin_url="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
    origin_url="${origin_url%.git}"
    case "$origin_url" in
      "https://github.com/$REPO_SLUG"|"git@github.com:$REPO_SLUG"|"ssh://git@github.com/$REPO_SLUG") ;;
      *) die "Existing checkout origin does not match github.com/$REPO_SLUG: ${origin_url:-missing}" ;;
    esac

    if ! git -C "$INSTALL_DIR" diff --quiet ||
       ! git -C "$INSTALL_DIR" diff --cached --quiet ||
       [[ -n "$(git -C "$INSTALL_DIR" ls-files --others --exclude-standard)" ]]; then
      warn "Local source changes were found. The checkout was not pulled or overwritten."
      return
    fi

    local current_branch
    current_branch="$(git -C "$INSTALL_DIR" branch --show-current)"
    if [[ "$current_branch" != "$BRANCH" ]]; then
      warn "The checkout is on '$current_branch', not '$BRANCH'; skipping the source update."
      return
    fi

    info "Fast-forwarding the existing checkout"
    git -C "$INSTALL_DIR" fetch --prune origin "$BRANCH"
    git -C "$INSTALL_DIR" merge --ff-only "origin/$BRANCH"
    return
  fi

  if [[ -d "$INSTALL_DIR" ]] &&
     [[ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    die "$INSTALL_DIR exists, is not a Git checkout, and is not empty."
  fi

  info "Cloning the public repository"
  git clone --branch "$BRANCH" --single-branch \
    "https://github.com/$REPO_SLUG.git" "$INSTALL_DIR"
}

generate_hex() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(Number(process.argv[1])).toString("hex"))' "$1"
}

ensure_secret() {
  local key="$1"
  local placeholder="$2"
  local bytes="$3"
  local env_file="$4"
  local line value
  local configured=0
  local key_found=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      key_found=1
      value="${line#*=}"
      if [[ -n "$value" && "$value" != "$placeholder" ]]; then
        configured=1
      fi
    fi
  done < "$env_file"

  ((configured == 0)) || return 0

  local generated tmp replaced=0
  generated="$(generate_hex "$bytes")"

  if ((key_found == 0)); then
    printf '\n%s=%s\n' "$key" "$generated" >> "$env_file"
    return
  fi

  tmp="$(mktemp "${env_file}.tmp.XXXXXX")"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* && $replaced -eq 0 ]]; then
      printf '%s=%s\n' "$key" "$generated" >> "$tmp"
      replaced=1
    elif [[ "$line" == "$key="* ]]; then
      # Drop duplicate empty/template definitions, but never reach this branch
      # when a configured value exists.
      continue
    else
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < "$env_file"
  chmod 600 "$tmp"
  mv -f "$tmp" "$env_file"
}

prepare_environment() {
  local env_file="$INSTALL_DIR/.env"
  if [[ ! -e "$env_file" ]]; then
    [[ -f "$INSTALL_DIR/.env.example" ]] || die ".env.example is missing from the checkout."
    cp "$INSTALL_DIR/.env.example" "$env_file"
  elif [[ ! -f "$env_file" ]]; then
    die "$env_file exists and is not a regular file."
  fi

  chmod 600 "$env_file"
  ensure_secret "DASHBOARD_TOKEN" "replace-with-a-long-random-token" 32 "$env_file"
  ensure_secret "APP_SECRET" "replace-with-64-random-hex-characters" 32 "$env_file"
  chmod 600 "$env_file"
  info "Environment prepared; existing configured values were preserved"
}

read_env_value() {
  local key="$1"
  local env_file="$2"
  local line value=""

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
  done < "$env_file"

  printf '%s' "$value"
}

resolve_data_dir() {
  local configured
  configured="$(read_env_value "DATA_DIR" "$INSTALL_DIR/.env")"
  configured="${configured:-./data}"

  if [[ "$configured" == /* ]]; then
    printf '%s' "$configured"
  else
    printf '%s/%s' "$INSTALL_DIR" "${configured#./}"
  fi
}

shell_single_quote() {
  local value="$1"
  # require_safe_install_dir already rejects single quotes.
  printf "'%s'" "$value"
}

install_termux_services() {
  local service_dir="$PREFIX/var/service/$SERVICE_NAME"
  local log_dir="$DATA_DIR_PATH/logs/runit"
  local run_file="$service_dir/run"
  local log_run_file="$service_dir/log/run"
  local quoted_install quoted_log

  quoted_install="$(shell_single_quote "$INSTALL_DIR")"
  quoted_log="$(shell_single_quote "$log_dir")"

  info "Installing runit services for StreamForge and SSH"
  mkdir -p "$service_dir/log" "$log_dir" "$HOME/.termux/boot"

  {
    printf '#!%s/bin/sh\n' "$PREFIX"
    printf 'cd %s || exit 111\n' "$quoted_install"
    printf 'exec env NODE_ENV=production %s/bin/node src/main.js\n' "$(shell_single_quote "$PREFIX")"
  } > "$run_file"

  {
    printf '#!%s/bin/sh\n' "$PREFIX"
    printf 'exec %s/bin/svlogd -tt %s\n' "$(shell_single_quote "$PREFIX")" "$quoted_log"
  } > "$log_run_file"

  printf '%s\n' 's1000000' 'n5' 't86400' > "$log_dir/config"
  chmod 700 "$run_file" "$log_run_file"

  # Termux:Boot runs this file when that optional Android app is installed.
  # It intentionally does not take a permanent wake lock.
  {
    printf '#!%s/bin/sh\n' "$PREFIX"
    printf '. %s/etc/profile.d/start-services.sh\n' "$(shell_single_quote "$PREFIX")"
  } > "$HOME/.termux/boot/start-streamforge-services"
  chmod 700 "$HOME/.termux/boot/start-streamforge-services"

  if [[ -r "$PREFIX/etc/profile.d/start-services.sh" ]]; then
    # A fresh termux-services install normally waits for the next interactive
    # shell. Source its official profile entrypoint so this one-command setup
    # can start runsvdir immediately.
    # shellcheck source=/dev/null
    . "$PREFIX/etc/profile.d/start-services.sh" >/dev/null 2>&1 || true
  fi

  sv-enable sshd >/dev/null
  sv-enable "$SERVICE_NAME" >/dev/null

  local attempt
  for ((attempt = 0; attempt < 50; attempt++)); do
    if sv status "$SERVICE_NAME" >/dev/null 2>&1 &&
       sv status sshd >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
  sv status "$SERVICE_NAME" >/dev/null 2>&1 ||
    die "The runit supervisor did not discover StreamForge. Reopen Termux and run install.sh again."
  sv status sshd >/dev/null 2>&1 ||
    die "The runit supervisor did not discover sshd. Reopen Termux and run install.sh again."

  sv restart "$SERVICE_NAME" >/dev/null
  sv status "$SERVICE_NAME" 2>/dev/null | grep -q '^run:' ||
    die "StreamForge did not reach the running state."

  sv up sshd >/dev/null 2>&1 || die "sshd was enabled but could not be started."
  sv status sshd 2>/dev/null | grep -q '^run:' ||
    die "sshd did not reach the running state."
  node -e '
    const net = require("node:net");
    const deadline = Date.now() + 3000;
    function probe() {
      const socket = net.createConnection({ host: "127.0.0.1", port: 8022 });
      socket.on("connect", () => {
        socket.destroy();
        process.exit(0);
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() < deadline) setTimeout(probe, 100);
        else process.exit(1);
      });
    }
    probe();
  ' || die "sshd reports running, but port 8022 is not accepting local connections."
}

verify_running_server() {
  local port health_url tls_cert tls_key public_base
  port="$(read_env_value "PORT" "$INSTALL_DIR/.env")"
  port="${port:-8787}"
  tls_cert="$(read_env_value "TLS_CERT_FILE" "$INSTALL_DIR/.env")"
  tls_key="$(read_env_value "TLS_KEY_FILE" "$INSTALL_DIR/.env")"
  public_base="$(read_env_value "PUBLIC_BASE_URL" "$INSTALL_DIR/.env")"
  if [[ -n "$tls_cert" && -n "$tls_key" ]]; then
    health_url="${public_base%/}/health"
  else
    health_url="http://127.0.0.1:$port/health"
  fi

  info "Waiting for the local health endpoint"
  node -e '
    const healthUrl = process.argv[1];
    const deadline = Date.now() + 30000;
    async function probe() {
      try {
        const response = await fetch(healthUrl, {
          signal: AbortSignal.timeout(1500),
        });
        if (response.ok) process.exit(0);
      } catch {}
      if (Date.now() >= deadline) process.exit(1);
      setTimeout(probe, 500);
    }
    probe();
  ' "$health_url" || die "StreamForge did not answer $health_url within 30 seconds."

  info "Running the post-install doctor"
  npm --prefix "$INSTALL_DIR" run doctor -- --require-running
}

detect_lan_ip() {
  node -e '
    const os = require("node:os");
    const addresses = Object.values(os.networkInterfaces()).flat().filter(Boolean);
    const preferred = addresses.find((item) =>
      item.family === "IPv4" &&
      !item.internal &&
      (/^192\.168\./.test(item.address) ||
       /^10\./.test(item.address) ||
       /^172\.(1[6-9]|2\d|3[01])\./.test(item.address))
    ) || addresses.find((item) => item.family === "IPv4" && !item.internal);
    if (preferred) process.stdout.write(preferred.address);
  ' 2>/dev/null || true
}

print_next_steps() {
  local lan_ip port phone_user dashboard_url tls_cert tls_key public_base
  lan_ip="$(detect_lan_ip)"
  lan_ip="${lan_ip:-<PHONE_LAN_IP>}"
  port="$(read_env_value "PORT" "$INSTALL_DIR/.env")"
  port="${port:-8787}"
  tls_cert="$(read_env_value "TLS_CERT_FILE" "$INSTALL_DIR/.env")"
  tls_key="$(read_env_value "TLS_KEY_FILE" "$INSTALL_DIR/.env")"
  public_base="$(read_env_value "PUBLIC_BASE_URL" "$INSTALL_DIR/.env")"
  if [[ -n "$tls_cert" && -n "$tls_key" ]]; then
    dashboard_url="${public_base%/}/"
  else
    dashboard_url="http://$lan_ip:$port/"
  fi
  phone_user="$(id -un)"

  printf '\n%s\n' "StreamForge Local is installed."
  printf '  Dashboard: %s\n' "$dashboard_url"
  if is_termux; then
    printf '  SSH from PC: ssh -p 8022 %s@%s\n' "$phone_user" "$lan_ip"
    printf '  Service:     sv status %s\n' "$SERVICE_NAME"
    printf '  Logs:        svlogtail %s\n' "$SERVICE_NAME"
  else
    printf '  Start:       cd %s && npm start\n' "$INSTALL_DIR"
  fi
  printf '\n%s\n' \
    "Before the first SSH login, add your PC public key as described in docs/TERMUX.md." \
    "Sign in with the local access key from .env, then configure Discord in the dashboard." \
    "Spotify and network bootstrap values remain in $INSTALL_DIR/.env." \
    "Do not expose port $port or Termux SSH port 8022 to the public internet."
}

main() {
  require_safe_install_dir

  if is_termux; then
    install_termux_packages
  else
    check_linux_runtime
  fi

  check_node_version
  clone_or_update

  [[ -f "$INSTALL_DIR/package-lock.json" ]] ||
    die "package-lock.json is required for a reproducible installation."

  info "Installing production Node.js dependencies"
  npm --prefix "$INSTALL_DIR" ci --omit=dev

  prepare_environment
  DATA_DIR_PATH="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$(resolve_data_dir)")"
  export DATA_DIR_PATH
  if [[ "$DATA_DIR_PATH" == *$'\n'* || "$DATA_DIR_PATH" == *"'"* ]]; then
    die "DATA_DIR cannot contain a newline or single quote."
  fi
  case "$DATA_DIR_PATH" in
    "/"|"$HOME"|"$INSTALL_DIR")
      die "Refusing to use unsafe DATA_DIR: $DATA_DIR_PATH"
      ;;
  esac
  mkdir -p "$DATA_DIR_PATH"

  chmod +x "$INSTALL_DIR/install.sh" "$INSTALL_DIR/scripts/"*.sh 2>/dev/null || true

  if is_termux; then
    install_termux_services
    verify_running_server
  fi

  print_next_steps
}

main "$@"
