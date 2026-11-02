#!/usr/bin/env bash
# Start and stop a Metro server for testing a worktree in Expo Go.
#
#   ./scripts/dev-mobile.sh start [--label <text>] [--host <host>] [--port <port>]
#   ./scripts/dev-mobile.sh stop
#   ./scripts/dev-mobile.sh restart [options]
#   ./scripts/dev-mobile.sh status
#   ./scripts/dev-mobile.sh rebuild
#
# See AGENTS.md and docs/mobile-testing.md.
# shellcheck disable=SC2153
set -euo pipefail

script_path="$(readlink -f "$0")"
root="$(git rev-parse --show-toplevel)"
cd "$root"

die() {
  echo "dev-mobile: $*" >&2
  exit 1
}

usage() {
  sed -n '3,9p' "$script_path" | sed 's/^# \{0,1\}//'
}

cmd="${1:-}"
case "$cmd" in
  start|stop|restart|status|rebuild) shift ;;
  help|--help|-h) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

# Re-run inside the Nix shell before parsing options, so all arguments survive.
if [[ $cmd == start || $cmd == restart || $cmd == rebuild ]]; then
  if ! command -v bun >/dev/null || ! command -v wasm-opt >/dev/null || ! command -v node >/dev/null; then
    if [[ -n ${TYPO_DEV_MOBILE_NIX:-} ]]; then
      die "bun, wasm-opt, and node are required. Run this from 'nix develop'."
    fi
    command -v nix >/dev/null || die "bun is not installed and nix is unavailable."
    export TYPO_DEV_MOBILE_NIX=1
    exec nix develop -c "$script_path" "$cmd" "$@"
  fi
fi

state_dir="$root/.expo"
state="$state_dir/dev-mobile"
cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/typo-dev"
log_dir="$cache_dir/logs"
ports_dir="$cache_dir/ports"
reserved_port=""
picked_port=""

cleanup_port_reservation() {
  if [[ -n $reserved_port ]]; then
    rm -rf "${ports_dir:?}/${reserved_port:?}"
  fi
}
trap cleanup_port_reservation EXIT

write_state() {
  mkdir -p "$state_dir"
  local tmp
  tmp="$(mktemp "$state.XXXXXX")"
  {
    printf 'PID=%q\n' "$1"
    printf 'PORT=%q\n' "$2"
    printf 'HOST=%q\n' "$3"
    printf 'URL=%q\n' "$4"
    printf 'CLIENT=%q\n' "$5"
    printf 'LABEL=%q\n' "$6"
    printf 'BRANCH=%q\n' "$7"
    printf 'WORKTREE=%q\n' "$8"
    printf 'LOG=%q\n' "$9"
  } >"$tmp"
  mv "$tmp" "$state"
}

kill_server() {
  local pid="$1" pgid=""
  kill -0 "$pid" 2>/dev/null || return 0
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  if [[ -n $pgid && $pgid == "$pid" ]]; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
  else
    kill -TERM "$pid" 2>/dev/null || true
  fi
  for _ in {1..50}; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  if [[ -n $pgid && $pgid == "$pid" ]]; then
    kill -KILL -- "-$pgid" 2>/dev/null || true
  else
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

acquire_worktree_lock() {
  mkdir -p "$state_dir"
  exec 8>"$state_dir/start.lock"
  if ! flock -w 300 8; then
    die "Timed out waiting for this worktree's previous start."
  fi
}

release_worktree_lock() {
  flock -u 8 2>/dev/null || true
  exec 8>&-
}

stop_server() {
  acquire_worktree_lock
  if [[ ! -f $state ]]; then
    release_worktree_lock
    echo "No saved server for this worktree."
    return 0
  fi
  # shellcheck disable=SC1090
  source "$state"
  if kill -0 "$PID" 2>/dev/null; then
    local cwd=""
    cwd="$(readlink "/proc/$PID/cwd" 2>/dev/null || true)"
    if [[ -n $cwd && $cwd != "$WORKTREE" ]]; then
      echo "PID $PID no longer belongs to this worktree. Removing stale state."
      rm -f "$state"
      rm -rf "${ports_dir:?}/${PORT:?}"
      release_worktree_lock
      return 0
    fi
    kill_server "$PID"
    echo "Stopped port $PORT."
  else
    echo "Server on port $PORT was already stopped."
  fi
  rm -f "$state"
  rm -rf "${ports_dir:?}/${PORT:?}"
  release_worktree_lock
}

detect_host() {
  if [[ -n ${DEV_HOST:-} ]]; then
    printf '%s\n' "$DEV_HOST"
    return
  fi
  if command -v tailscale >/dev/null; then
    local name
    name="$(
      tailscale status --json 2>/dev/null |
        node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const n=JSON.parse(s).Self.DNSName;if(n)console.log(n.replace(/\.$/,""))}catch{}})' 2>/dev/null
    )"
    if [[ -n $name ]]; then
      printf '%s\n' "$name"
      return
    fi
    local ip
    ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
    if [[ -n $ip ]]; then
      printf '%s\n' "$ip"
      return
    fi
  fi
  hostname -I 2>/dev/null | awk '{print $1}'
}

port_free() {
  node -e '
    const net = require("net")
    const s = net.createServer()
    s.once("error", () => process.exit(1))
    s.listen(Number(process.argv[1]), "0.0.0.0", () => s.close(() => process.exit(0)))
  ' "$1" 2>/dev/null
}

try_reserve_port() {
  local p="$1" dir="$ports_dir/$1" pid="" owner_cwd="" owner_worktree=""
  mkdir -p "$ports_dir"
  exec 7>"$ports_dir/$p.lock"
  if ! flock -n 7; then
    exec 7>&-
    return 1
  fi
  if [[ -d $dir ]]; then
    pid="$(cat "$dir/pid" 2>/dev/null || true)"
    owner_worktree="$(cat "$dir/worktree" 2>/dev/null || true)"
    if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then
      owner_cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
      if [[ -z $owner_cwd || -z $owner_worktree || $owner_cwd == "$owner_worktree" ]]; then
        exec 7>&-
        return 1
      fi
    fi
    if ! port_free "$p"; then
      exec 7>&-
      return 1
    fi
    rm -rf "$dir"
  fi
  if ! mkdir "$dir"; then
    exec 7>&-
    return 1
  fi
  printf '%s\n' "$$" >"$dir/pid"
  printf '%s\n' "$root" >"$dir/worktree"
  date +%s >"$dir/started"
  reserved_port="$p"
  exec 7>&-
  return 0
}

pick_port() {
  # Stable per worktree, so the reported link survives restarts.
  local base p i
  base="$(
    node -e 'const h=require("crypto").createHash("sha1").update(process.argv[1]).digest().readUInt16BE(0);process.stdout.write(String(8100+(h%100)))' \
      "$root"
  )"
  for i in $(seq 0 99); do
    p=$((8100 + (base - 8100 + i) % 100))
    if try_reserve_port "$p"; then
      picked_port="$p"
      return 0
    fi
  done
  die "No free port between 8100 and 8199."
}

build_dist() {
  local force="${1:-0}" stamp="$root/dist/.dev-mobile-stamp" f
  if [[ $force -eq 0 && -f $stamp ]]; then
    for f in editor compiler compiler-worker pdf pdf-worker; do
      if [[ ! -f "$root/dist/$f.bundle.txt" ]]; then
        force=1
        break
      fi
    done
    [[ -f $root/dist/compiler.wasm ]] || force=1
  fi
  if [[ $force -eq 0 && -f $stamp ]]; then
    if ! find src/editor src/compiler src/pdf src/web-runtime.ts scripts/build-web.ts \
      package.json bun.lock -newer "$stamp" -print -quit 2>/dev/null | grep -q .; then
      echo "dist is up to date."
      return
    fi
  fi
  echo "Building web bundles..."
  bun run build:web
  touch "$stamp"
}

start_server() {
  local label="" host="" port="" client="go"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --label|--host|--port)
        [[ $# -ge 2 ]] || die "$1 needs a value."
        case "$1" in
          --label) label="$2" ;;
          --host) host="$2" ;;
          --port) port="$2" ;;
        esac
        shift 2
        ;;
      --dev-client) client="dev-client"; shift ;;
      *) die "Unknown option: $1" ;;
    esac
  done

  acquire_worktree_lock
  if [[ -f $state ]]; then
    # shellcheck disable=SC1090
    source "$state"
    if kill -0 "$PID" 2>/dev/null; then
      if curl -fsS -m 2 "http://127.0.0.1:$PORT/status" >/dev/null 2>&1; then
        release_worktree_lock
        echo "Already running on port $PORT."
        echo "Link: $URL"
        echo "Log: $LOG"
        echo "Stop: $script_path stop"
        return
      fi
      echo "Process $PID is alive but Metro is not responding." >&2
      echo "Run '$script_path restart' or '$script_path stop'." >&2
      exit 1
    fi
    rm -f "$state"
    rm -rf "${ports_dir:?}/${PORT:?}"
  fi

  [[ -n $host ]] || host="$(detect_host)"
  [[ -n $host ]] || die "Could not detect a network host. Pass --host."
  [[ -n $label ]] || label="$(git branch --show-current || true)"
  [[ -n $label ]] || label="detached"

  bun install --frozen-lockfile
  build_dist 0

  if [[ -z $port ]]; then
    pick_port
    port="$picked_port"
  elif ! try_reserve_port "$port"; then
    die "Port $port is in use."
  fi

  mkdir -p "$log_dir"
  log="$log_dir/$port.log"
  local expo_args=(start --host lan --port "$port")
  if [[ $client == "dev-client" ]]; then
    expo_args+=(--dev-client)
  else
    expo_args+=(--go)
  fi

  echo "Starting Metro on port $port for $label..."
  if command -v setsid >/dev/null; then
    setsid env REACT_NATIVE_PACKAGER_HOSTNAME="$host" EXPO_NO_TELEMETRY=1 \
      "$root/node_modules/.bin/expo" "${expo_args[@]}" 8>&- 9>&- >"$log" 2>&1 </dev/null &
  else
    nohup env REACT_NATIVE_PACKAGER_HOSTNAME="$host" EXPO_NO_TELEMETRY=1 \
      "$root/node_modules/.bin/expo" "${expo_args[@]}" 8>&- 9>&- >"$log" 2>&1 </dev/null &
  fi
  local pid=$!
  printf '%s\n' "$pid" >"$ports_dir/$port/pid.$$.tmp"
  mv "$ports_dir/$port/pid.$$.tmp" "$ports_dir/$port/pid"

  local manifest="$cache_dir/manifest-$port.json" bundle_url
  local ready=0
  for _ in {1..120}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      tail -n 20 "$log" >&2 || true
      die "Metro exited. See $log."
    fi
    if curl -fsS -m 2 -H 'expo-platform: android' -H 'accept: application/expo+json' \
      "http://127.0.0.1:$port/" -o "$manifest" 2>/dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ $ready -eq 1 ]] || {
    tail -n 20 "$log" >&2 || true
    kill_server "$pid"
    die "Metro did not become ready. See $log."
  }

  local host_uri
  host_uri="$(
    node -e 'const m=require(process.argv[1]);process.stdout.write(m.extra?.expoClient?.hostUri||"")' \
      "$manifest" 2>/dev/null || true
  )"
  if [[ $host_uri != "$host:$port" ]]; then
    tail -n 20 "$log" >&2 || true
    kill_server "$pid"
    die "Metro advertises '$host_uri', expected '$host:$port'. Check --host."
  fi

  bundle_url="$(
    node -e 'const m=require(process.argv[1]);process.stdout.write(m.launchAsset?.url||"")' \
      "$manifest" 2>/dev/null || true
  )"
  [[ -n $bundle_url ]] || {
    kill_server "$pid"
    die "Manifest has no bundle URL."
  }
  echo "Checking the Android bundle..."
  if ! curl -fsS -m 180 --resolve "$host:$port:127.0.0.1" -o /dev/null "$bundle_url"; then
    tail -n 20 "$log" >&2 || true
    kill_server "$pid"
    die "The Android bundle failed. See $log."
  fi

  local url
  if [[ $client == "dev-client" ]]; then
    local scheme
    scheme="$(node -p 'require("./app.json").expo.slug' 2>/dev/null || echo typo)"
    url="$(
      node -e 'process.stdout.write("exp+"+process.argv[1]+"://?__expo_url="+encodeURIComponent("http://"+process.argv[2]+":"+process.argv[3]))' \
        "$scheme" "$host" "$port"
    )"
  else
    url="exp://$host:$port"
  fi

  local branch
  branch="$(git branch --show-current || true)"
  write_state "$pid" "$port" "$host" "$url" "$client" "$label" "$branch" "$root" "$log"
  reserved_port=""
  release_worktree_lock

  echo
  if [[ $client == "dev-client" ]]; then
    echo "Development build link: $url"
    echo "This needs an installed development build, not Expo Go."
  else
    echo "Open in Expo Go: $url"
  fi
  echo "Branch: ${branch:-detached} ($label)"
  echo "Log: $log"
  echo "Stop: $script_path stop"
}

case "$cmd" in
  start)
    start_server "$@"
    ;;
  restart)
    stop_server
    start_server "$@"
    ;;
  stop)
    stop_server
    ;;
  status)
    if [[ ! -f $state ]]; then
      echo "No server saved for this worktree."
      exit 1
    fi
    # shellcheck disable=SC1090
    source "$state"
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "Not running (stale state for port $PORT)."
      exit 1
    fi
    if ! curl -fsS -m 2 "http://127.0.0.1:$PORT/status" >/dev/null 2>&1; then
      echo "Process $PID is alive but Metro is not responding on port $PORT."
      echo "Log: $LOG"
      exit 1
    fi
    echo "Running on port $PORT."
    echo "Link: $URL"
    echo "Branch: ${BRANCH:-detached} ($LABEL)"
    echo "Log: $LOG"
    ;;
  rebuild)
    build_dist 1
    echo "Reload the app to pick up the new bundles."
    ;;
esac
