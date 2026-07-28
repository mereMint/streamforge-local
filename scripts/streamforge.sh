#!/usr/bin/env bash
#
# StreamForge Local lifecycle controller.
#
# Prefer the runit service installed by install.sh. When runit is not installed
# or its supervisor is not reachable, use a small PID-file based fallback so
# the same command also works on a preliminary generic Linux installation.

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
DEFAULT_PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PROJECT_DIR="${STREAMFORGE_HOME:-$DEFAULT_PROJECT_DIR}"
SERVICE_NAME="${STREAMFORGE_SERVICE_NAME:-streamforge}"
RUNTIME_DIR="${STREAMFORGE_CONTROL_RUNTIME_DIR:-$PROJECT_DIR/.runtime}"
PID_FILE="$RUNTIME_DIR/$SERVICE_NAME.pid"
DIRECT_LOG="$RUNTIME_DIR/$SERVICE_NAME.log"
NODE_BIN="${STREAMFORGE_NODE_BIN:-node}"

if [[ -n "${SVDIR:-}" ]]; then
  SERVICE_ROOT="$SVDIR"
elif [[ -n "${PREFIX:-}" ]]; then
  SERVICE_ROOT="$PREFIX/var/service"
else
  SERVICE_ROOT=""
fi

if [[ -n "${LOGDIR:-}" ]]; then
  SERVICE_LOG_BASE="${LOGDIR%/}"
  SERVICE_LOG_ROOT="$SERVICE_LOG_BASE/sv"
elif [[ -n "${PREFIX:-}" ]]; then
  SERVICE_LOG_BASE="$PREFIX/var/log"
  SERVICE_LOG_ROOT="$PREFIX/var/log/sv"
else
  SERVICE_LOG_BASE=""
  SERVICE_LOG_ROOT=""
fi

if [[ -n "${STREAMFORGE_SERVICE_DIR:-}" ]]; then
  SERVICE_DIR="$STREAMFORGE_SERVICE_DIR"
elif [[ -n "$SERVICE_ROOT" ]]; then
  SERVICE_DIR="$SERVICE_ROOT/$SERVICE_NAME"
else
  SERVICE_DIR=""
fi

info() {
  printf '%s\n' "$*"
}

warn() {
  printf 'Warning: %s\n' "$*" >&2
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: streamforge COMMAND [OPTIONS]

Commands:
  run               Run StreamForge in the foreground (debugging)
  start             Start StreamForge
  stop              Stop StreamForge
  restart           Restart StreamForge
  status            Show supervisor, process, and health status
  logs [-f] [LINES] Show recent logs; -f follows them
  doctor            Run the built-in installation checks
  help              Show this help

The runit service is used when available. Otherwise StreamForge is run directly
in the background with its PID and log stored in .runtime/.
EOF
}

require_project() {
  [[ -d "$PROJECT_DIR" ]] || die "Project directory does not exist: $PROJECT_DIR"
  [[ -f "$PROJECT_DIR/src/main.js" ]] ||
    die "StreamForge source is missing from $PROJECT_DIR"
  [[ -f "$PROJECT_DIR/package.json" ]] ||
    die "package.json is missing from $PROJECT_DIR"
}

read_pid() {
  local pid=""
  [[ -f "$PID_FILE" ]] || return 1
  IFS= read -r pid < "$PID_FILE" || true
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s' "$pid"
}

direct_process_is_running() {
  local pid command_line
  pid="$(read_pid)" || return 1
  kill -0 "$pid" 2>/dev/null || return 1

  # On Linux/Termux, reject a stale PID file that now names another process.
  if [[ -r "/proc/$pid/cmdline" ]]; then
    command_line="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
    [[ "$command_line" == *"src/main.js"* ]] || return 1
  fi

  return 0
}

remove_stale_pid() {
  if [[ -f "$PID_FILE" ]] && ! direct_process_is_running; then
    rm -f -- "$PID_FILE"
  fi
}

runit_is_configured() {
  [[ "${STREAMFORGE_SERVICE_MODE:-auto}" != "direct" ]] &&
    [[ -n "$SERVICE_DIR" ]] &&
    [[ -d "$SERVICE_DIR" ]] &&
    command -v sv >/dev/null 2>&1
}

runit_is_reachable() {
  runit_is_configured || return 1
  sv status "$SERVICE_DIR" >/dev/null 2>&1
}

try_start_runit_supervisor() {
  runit_is_configured || return 1
  runit_is_reachable && return 0

  if [[ -n "$SERVICE_ROOT" && -n "$SERVICE_LOG_BASE" ]]; then
    export SVDIR="$SERVICE_ROOT"
    export LOGDIR="$SERVICE_LOG_BASE"
  fi

  if command -v service-daemon >/dev/null 2>&1; then
    service-daemon start >/dev/null 2>&1 || true
  elif [[ -n "${PREFIX:-}" && -x "$PREFIX/bin/service-daemon" ]]; then
    "$PREFIX/bin/service-daemon" start >/dev/null 2>&1 || true
  fi

  local attempt
  for ((attempt = 0; attempt < 150; attempt++)); do
    runit_is_reachable && return 0
    sleep 0.1
  done
  return 1
}

service_log_file() {
  [[ -n "$SERVICE_LOG_ROOT" ]] || return 1
  printf '%s/%s/current' "$SERVICE_LOG_ROOT" "$SERVICE_NAME"
}

show_runit_failure() {
  local log_file
  printf '%s\n' "runit status:" >&2
  sv status "$SERVICE_DIR" >&2 || true
  log_file="$(service_log_file 2>/dev/null || true)"
  if [[ -n "$log_file" && -f "$log_file" ]]; then
    printf '%s\n' "Recent StreamForge logs:" >&2
    tail -n 40 "$log_file" >&2 || true
  else
    printf 'No runit log exists yet at %s\n' \
      "${log_file:-<Termux service log directory unavailable>}" >&2
  fi
}

stop_direct_if_running() {
  local quiet="${1:-false}"
  local pid attempt
  remove_stale_pid
  if ! direct_process_is_running; then
    [[ "$quiet" == "true" ]] || info "StreamForge is already stopped."
    return 0
  fi

  pid="$(read_pid)"
  kill -TERM "$pid"
  for ((attempt = 0; attempt < 100; attempt++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f -- "$PID_FILE"
      [[ "$quiet" == "true" ]] || info "StreamForge stopped."
      return 0
    fi
    sleep 0.1
  done

  warn "StreamForge did not stop within 10 seconds; sending SIGKILL."
  kill -KILL "$pid" 2>/dev/null || true
  rm -f -- "$PID_FILE"
  [[ "$quiet" == "true" ]] || info "StreamForge stopped."
}

start_direct() {
  local pid attempt
  remove_stale_pid
  if direct_process_is_running; then
    info "StreamForge is already running directly (PID $(read_pid))."
    return 0
  fi

  mkdir -p -- "$RUNTIME_DIR"
  chmod 700 "$RUNTIME_DIR"
  touch "$DIRECT_LOG"
  chmod 600 "$DIRECT_LOG"

  (
    cd -- "$PROJECT_DIR"
    nohup env NODE_ENV=production "$NODE_BIN" src/main.js \
      >> "$DIRECT_LOG" 2>&1 < /dev/null &
    printf '%s\n' "$!" > "$PID_FILE"
  )

  pid="$(read_pid)" || die "StreamForge was launched but no valid PID was recorded."
  for ((attempt = 0; attempt < 30; attempt++)); do
    if direct_process_is_running; then
      sleep 0.5
      if direct_process_is_running; then
        info "StreamForge started directly (PID $pid)."
        info "Logs: $DIRECT_LOG"
        return 0
      fi
    fi
    sleep 0.1
  done

  rm -f -- "$PID_FILE"
  printf '%s\n' "StreamForge exited during startup. Recent logs:" >&2
  tail -n 40 "$DIRECT_LOG" >&2 || true
  return 1
}

start_streamforge() {
  require_project
  if try_start_runit_supervisor; then
    # A stale fallback process could otherwise race the supervised instance.
    stop_direct_if_running true
    if ! sv up "$SERVICE_DIR"; then
      show_runit_failure
      die "runit rejected the StreamForge start request."
    fi
    sleep 0.5
    if sv status "$SERVICE_DIR" 2>/dev/null | grep -q '^run:'; then
      if wait_for_health; then
        info "StreamForge started under runit."
        sv status "$SERVICE_DIR"
        info "health: OK ($(health_url))"
        return 0
      fi
      show_runit_failure
      die "StreamForge is running, but $(health_url) did not answer within 30 seconds."
    fi
    show_runit_failure
    die "runit could not keep StreamForge running. Run 'streamforge logs'."
  fi

  runit_is_configured &&
    warn "The runit supervisor is unavailable; using the direct fallback."
  start_direct
}

stop_streamforge() {
  local handled=false attempt
  if runit_is_reachable; then
    if ! sv down "$SERVICE_DIR"; then
      show_runit_failure
      die "runit rejected the StreamForge stop request."
    fi
    for ((attempt = 0; attempt < 50; attempt++)); do
      if sv status "$SERVICE_DIR" 2>/dev/null | grep -q '^down:'; then
        info "StreamForge stopped under runit."
        handled=true
        break
      fi
      sleep 0.1
    done
    if [[ "$handled" != "true" ]]; then
      show_runit_failure
      die "runit did not confirm that StreamForge stopped."
    fi
  fi

  remove_stale_pid
  if direct_process_is_running; then
    stop_direct_if_running
    handled=true
  fi

  [[ "$handled" == "true" ]] || info "StreamForge is already stopped."
}

restart_streamforge() {
  require_project
  if try_start_runit_supervisor; then
    stop_direct_if_running true
    if ! sv restart "$SERVICE_DIR"; then
      show_runit_failure
      die "runit rejected the StreamForge restart request."
    fi
    sleep 0.5
    if sv status "$SERVICE_DIR" 2>/dev/null | grep -q '^run:'; then
      if wait_for_health; then
        info "StreamForge restarted under runit."
        sv status "$SERVICE_DIR"
        info "health: OK ($(health_url))"
        return 0
      fi
      show_runit_failure
      die "StreamForge restarted, but $(health_url) did not answer within 30 seconds."
    fi
    show_runit_failure
    die "runit could not keep StreamForge running. Run 'streamforge logs'."
  fi

  runit_is_configured &&
    warn "The runit supervisor is unavailable; using the direct fallback."
  stop_direct_if_running true
  start_direct
}

health_url() {
  local port="8787" public_base="" tls_cert="" tls_key="" line key value
  if [[ -f "$PROJECT_DIR/.env" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ "$line" == *=* ]] || continue
      key="${line%%=*}"
      value="${line#*=}"
      value="${value%$'\r'}"
      if [[ "$value" == \"*\" && "$value" == *\" ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
        value="${value:1:${#value}-2}"
      fi
      case "$key" in
        PORT) port="${value:-8787}" ;;
        PUBLIC_BASE_URL) public_base="$value" ;;
        TLS_CERT_FILE) tls_cert="$value" ;;
        TLS_KEY_FILE) tls_key="$value" ;;
      esac
    done < "$PROJECT_DIR/.env"
  fi

  if [[ -n "$tls_cert" && -n "$tls_key" && -n "$public_base" ]]; then
    printf '%s/health' "${public_base%/}"
  else
    printf 'http://127.0.0.1:%s/health' "$port"
  fi
}

probe_health() {
  "$NODE_BIN" -e '
    fetch(process.argv[1], { signal: AbortSignal.timeout(2000) })
      .then((response) => process.exit(response.ok ? 0 : 1))
      .catch(() => process.exit(1));
  ' "$(health_url)" >/dev/null 2>&1
}

wait_for_health() {
  local attempt
  for ((attempt = 0; attempt < 60; attempt++)); do
    probe_health && return 0
    sleep 0.5
  done
  return 1
}

status_streamforge() {
  local running=false
  if runit_is_reachable; then
    sv status "$SERVICE_DIR" || true
    if sv status "$SERVICE_DIR" 2>/dev/null | grep -q '^run:'; then
      running=true
    fi
  else
    remove_stale_pid
    if direct_process_is_running; then
      info "run: StreamForge direct fallback (PID $(read_pid))"
      running=true
    else
      info "down: StreamForge is not running"
    fi
  fi

  if [[ "$running" == "true" ]]; then
    if probe_health; then
      info "health: OK ($(health_url))"
      return 0
    fi
    warn "The process is running, but $(health_url) did not answer."
    return 1
  fi
  return 3
}

logs_streamforge() {
  local follow=false lines=100 argument log_file=""
  for argument in "$@"; do
    case "$argument" in
      -f|--follow) follow=true ;;
      ''|*[!0-9]*) die "logs accepts only -f/--follow and a numeric line count." ;;
      *) lines="$argument" ;;
    esac
  done

  if runit_is_configured; then
    log_file="$(service_log_file 2>/dev/null || true)"
    [[ -f "$log_file" ]] || log_file=""
  fi

  [[ -n "$log_file" ]] || log_file="$DIRECT_LOG"
  [[ -f "$log_file" ]] || die "No StreamForge log exists yet."
  if [[ "$follow" == "true" ]]; then
    exec tail -n "$lines" -F "$log_file"
  fi
  tail -n "$lines" "$log_file"
}

run_doctor() {
  require_project
  cd -- "$PROJECT_DIR"
  exec npm run doctor -- "$@"
}

run_foreground() {
  require_project
  cd -- "$PROJECT_DIR"
  exec env NODE_ENV="${NODE_ENV:-production}" "$NODE_BIN" src/main.js "$@"
}

command="${1:-help}"
if (($#)); then
  shift
fi

case "$command" in
  run) run_foreground "$@" ;;
  start) (($# == 0)) || die "start does not accept arguments."; start_streamforge ;;
  stop) (($# == 0)) || die "stop does not accept arguments."; stop_streamforge ;;
  restart) (($# == 0)) || die "restart does not accept arguments."; restart_streamforge ;;
  status) (($# == 0)) || die "status does not accept arguments."; status_streamforge ;;
  logs) logs_streamforge "$@" ;;
  doctor) run_doctor "$@" ;;
  help|-h|--help) usage ;;
  *) usage >&2; die "Unknown command: $command" ;;
esac
