#!/usr/bin/env bash
#
# Shelf installer — https://github.com/murygin-ds/shelf
#
#   curl -fsSL https://raw.githubusercontent.com/murygin-ds/shelf/main/install.sh \
#     | sudo bash -s -- --domain notes.example.com --email you@example.com
#
# Everything below is a function and the only statement outside one is the call to main on the
# last line. bash executes a pipe as it arrives: without that, a connection dropped halfway
# would run half an installation and report nothing wrong.

set -Eeuo pipefail

readonly INSTALLER_VERSION="1.0.0"
readonly DEFAULT_REPO="https://github.com/murygin-ds/shelf.git"
readonly DEFAULT_BRANCH="main"
readonly DEFAULT_DIR="/opt/shelf"
readonly STAGING_CA="https://acme-staging-v02.api.letsencrypt.org/directory"

# Candidates for the container network. The subnet has to be fixed rather than assigned,
# because SHELF_HTTP_TRUSTED_PROXIES names it, and one Docker picks would move underneath it.
readonly SUBNET_CANDIDATES=(
	172.28.0.0/16 172.29.0.0/16 172.30.0.0/16 172.31.0.0/16 10.99.0.0/16 10.98.0.0/16
)

DOMAIN=${SHELF_DOMAIN:-}
ACME_EMAIL=${ACME_EMAIL:-}
ACME_CA=""
DIR=${SHELF_INSTALL_DIR:-$DEFAULT_DIR}
DIR_EXPLICIT=0
REPO=${SHELF_REPO:-$DEFAULT_REPO}
BRANCH=${SHELF_BRANCH:-$DEFAULT_BRANCH}
IMAGE=${SHELF_IMAGE:-}
MCP=""
STAGING=0
SWAP_CHOICE=""
SKIP_DNS_CHECK=0
NON_INTERACTIVE=${SHELF_NONINTERACTIVE:+1}
NON_INTERACTIVE=${NON_INTERACTIVE:-0}
ASSUME_YES=0
MODE="install"
FORCE=0
PURGE=0

INTERACTIVE=0
SKIP_GIT=0
CURRENT_STEP=""
OS_ID=""
OS_VERSION=""
ENV_FILE=""
SUBNET=""
C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""

setup_colors() {
	# NO_COLOR is the convention; a pipe or a dumb terminal is the other half of the test.
	if [[ -t 2 && -z ${NO_COLOR:-} && ${TERM:-dumb} != dumb ]]; then
		C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
		C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
	fi
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

step() { CURRENT_STEP="$*"; printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET" >&2; }
ok()   { printf '  %s+%s %s\n' "$C_GREEN" "$C_RESET" "$*" >&2; }
info() { printf '  %s-%s %s\n' "$C_DIM" "$C_RESET" "$*" >&2; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '\n%serror:%s %s\n\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# set -e reports a line number and nothing else, which for an install of this length is not
# enough to act on. This names the step that was running when it happened.
on_error() {
	local code=$? line=$1
	printf '\n%sfailed%s at line %s (exit %s), during: %s\n' \
		"$C_RED" "$C_RESET" "$line" "$code" "${CURRENT_STEP:-startup}" >&2
	print_diagnostics
	exit "$code"
}

print_diagnostics() {
	[[ -f ${ENV_FILE:-} ]] || return 0
	cat >&2 <<DIAG

Where to look:
  cd $DIR && docker compose logs app
  cd $DIR && docker compose logs caddy
  cd $DIR && docker compose ps
  cat $ENV_FILE          # the secrets live here, and nothing regenerates them

Nothing was rolled back. Fixing the cause and running this script again is safe: it reuses
every secret it has already written.
DIAG
}

# stdin is the pipe carrying this script, so a question has to be asked somewhere else.
# /dev/tty is the controlling terminal whatever stdin points at, and it does not exist under
# cron, in a container, or over a connection without a pty.
setup_tty() {
	if (( NON_INTERACTIVE )); then
		return
	fi
	# The redirection has to wrap the exec rather than sit beside it: a failing 3</dev/tty is
	# reported before a 2>/dev/null on the same line has been applied.
	if { exec 3</dev/tty; } 2>/dev/null; then
		INTERACTIVE=1
	else
		warn "no terminal available, continuing without asking anything"
	fi
}

# ask <prompt> <default> <variable-name>
ask() {
	local prompt=$1 default=$2 name=$3 reply
	if (( ! INTERACTIVE )); then
		[[ -n $default ]] || die "$name was not given and there is no terminal to ask on.
Pass it as a flag — see --help for the full list."
		printf -v "$name" '%s' "$default"
		return
	fi
	if [[ -n $default ]]; then
		printf '  %s [%s]: ' "$prompt" "$default" >&2
	else
		printf '  %s: ' "$prompt" >&2
	fi
	read -r reply <&3 || reply=""
	printf -v "$name" '%s' "${reply:-$default}"
}

# confirm <question> <default y|n>
confirm() {
	local reply
	(( ASSUME_YES )) && return 0
	if (( ! INTERACTIVE )); then
		[[ $2 == y ]]
		return
	fi
	if [[ $2 == y ]]; then
		printf '  %s [Y/n]: ' "$1" >&2
	else
		printf '  %s [y/N]: ' "$1" >&2
	fi
	read -r reply <&3 || reply=""
	reply=${reply:-$2}
	[[ $(lower "$reply") == y* ]]
}

usage() {
	cat <<USAGE
Shelf installer $INSTALLER_VERSION

  curl -fsSL https://raw.githubusercontent.com/murygin-ds/shelf/main/install.sh \\
    | sudo bash -s -- --domain notes.example.com --email you@example.com

The -s -- is not decoration: without it bash reads the first flag as a filename.

  --domain <fqdn>        The name on the certificate, and the address given to Claude
  --email <address>      Where Let's Encrypt sends expiry notices
  --enable-mcp           Mount the Claude connector
  --no-mcp               Leave the connector off, without being asked
  --dir <path>           Where the clone and .env live (default: $DEFAULT_DIR)
  --repo <url>           Install from a fork (default: $DEFAULT_REPO)
  --branch <name>        Branch to install (default: $DEFAULT_BRANCH)
  --image <ref>          Use a prebuilt image instead of compiling here
  --staging              Issue from Let's Encrypt staging: untrusted certs, generous limits
  --swap, --no-swap      Create /swapfile so the build survives on a small machine
  --skip-dns-check       Proceed although the domain does not resolve to this machine
  --non-interactive      Never ask; a missing answer is an error
  --yes, -y              Answer yes to every confirmation
  --update               Pull, rebuild and restart, keeping .env and every secret in it
  --force                With --update, discard local edits to tracked files
  --uninstall            Stop and remove the containers; the volumes stay
  --purge                With --uninstall, delete the database and certificates too
  --version, --help

Every flag has an environment variable of the same meaning: SHELF_DOMAIN, ACME_EMAIL,
SHELF_MCP_ENABLED, SHELF_INSTALL_DIR, SHELF_REPO, SHELF_BRANCH, SHELF_IMAGE,
SHELF_NONINTERACTIVE.
USAGE
}

parse_args() {
	while (( $# )); do
		case $1 in
		--domain)          DOMAIN=${2:?--domain needs a value}; shift 2 ;;
		--domain=*)        DOMAIN=${1#*=}; shift ;;
		--email)           ACME_EMAIL=${2:?--email needs a value}; shift 2 ;;
		--email=*)         ACME_EMAIL=${1#*=}; shift ;;
		--enable-mcp)      MCP=1; shift ;;
		--no-mcp)          MCP=0; shift ;;
		--dir)             DIR=${2:?--dir needs a value}; DIR_EXPLICIT=1; shift 2 ;;
		--dir=*)           DIR=${1#*=}; DIR_EXPLICIT=1; shift ;;
		--repo)            REPO=${2:?--repo needs a value}; shift 2 ;;
		--repo=*)          REPO=${1#*=}; shift ;;
		--branch)          BRANCH=${2:?--branch needs a value}; shift 2 ;;
		--branch=*)        BRANCH=${1#*=}; shift ;;
		--image)           IMAGE=${2:?--image needs a value}; shift 2 ;;
		--image=*)         IMAGE=${1#*=}; shift ;;
		--staging)         STAGING=1; shift ;;
		--swap)            SWAP_CHOICE=yes; shift ;;
		--no-swap)         SWAP_CHOICE=no; shift ;;
		--skip-dns-check)  SKIP_DNS_CHECK=1; shift ;;
		--non-interactive) NON_INTERACTIVE=1; shift ;;
		--yes|-y)          ASSUME_YES=1; shift ;;
		--update)          MODE=update; shift ;;
		--force)           FORCE=1; shift ;;
		--uninstall)       MODE=uninstall; shift ;;
		--purge)           PURGE=1; shift ;;
		--version)         printf 'shelf installer %s\n' "$INSTALLER_VERSION"; exit 0 ;;
		--help|-h)         usage; exit 0 ;;
		--)                shift; break ;;
		*)                 usage >&2; die "unknown argument: $1" ;;
		esac
	done

	# SHELF_MCP_ENABLED is the environment form of --enable-mcp, and only an explicit flag
	# overrides it.
	if [[ -z $MCP && -n ${SHELF_MCP_ENABLED:-} ]]; then
		if [[ $(lower "$SHELF_MCP_ENABLED") == true || $SHELF_MCP_ENABLED == 1 ]]; then MCP=1; else MCP=0; fi
	fi
	if (( STAGING )); then ACME_CA=$STAGING_CA; fi
	ENV_FILE="$DIR/.env"
}

validate_domain() {
	# A wildcard, a port, a scheme or a bare label all fail later in ways that read like a Caddy
	# problem. They are cheap to refuse now.
	[[ $DOMAIN =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$ ]] \
		|| die "not a hostname: $DOMAIN
Give a name Let's Encrypt can issue for, with no scheme, no port and no wildcard."
	[[ $ACME_EMAIL == *@*.* && $ACME_EMAIL != *' '* ]] \
		|| die "not an email address: $ACME_EMAIL"
}

require_root() {
	# With `curl | bash` there is no file on disk to re-exec through sudo, so this can only be
	# reported rather than fixed.
	(( EUID == 0 )) || die "this has to run as root: it writes to $DIR, drives the Docker daemon
and binds port 443.

    curl -fsSL <url>/install.sh | sudo bash -s -- --domain ... --email ..."
	(( BASH_VERSINFO[0] >= 4 )) || die "bash 4 or newer is required (this is ${BASH_VERSION})"
}

detect_os() {
	# Read rather than sourced: /etc/os-release is a file this script does not own, and running
	# it would let a distribution's VERSION= land on top of a variable here.
	if [[ -r /etc/os-release ]]; then
		OS_ID=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"' | head -1)
		OS_VERSION=$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"' | head -1)
	fi
	OS_ID=${OS_ID:-unknown}

	case $OS_ID in
	debian|ubuntu) ok "$OS_ID ${OS_VERSION:-} on $(uname -m)" ;;
	*)             info "$OS_ID ${OS_VERSION:-} on $(uname -m): supported only if Docker is already installed" ;;
	esac

	case $(uname -m) in
	x86_64|aarch64|arm64) ;;
	*) warn "$(uname -m) is not an architecture the base images are all published for" ;;
	esac
}

ensure_base_tools() {
	local missing=()
	for tool in curl git; do
		command -v "$tool" >/dev/null || missing+=("$tool")
	done
	(( ${#missing[@]} )) || return 0

	step "installing ${missing[*]}"
	case $OS_ID in
	debian|ubuntu)
		DEBIAN_FRONTEND=noninteractive apt-get update -qq
		DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates "${missing[@]}" >/dev/null
		;;
	fedora|rhel|centos|rocky|almalinux)
		"$(command -v dnf || command -v yum)" install -y ca-certificates "${missing[@]}" >/dev/null
		;;
	*)
		die "${missing[*]} not found, and $OS_ID is not one this script installs packages on.
Install them and run this again."
		;;
	esac
	ok "${missing[*]} installed"
}

check_disk() {
	local target avail
	target=$DIR
	# $DIR may not exist yet, and neither may its parent on a fresh machine.
	while [[ ! -d $target && $target != / ]]; do target=$(dirname "$target"); done
	avail=$(df -Pk "$target" | awk 'NR==2 {print int($4/1024/1024)}')
	if (( avail < 5 )); then
		die "only ${avail} GB free on $(dirname "$DIR"). The images, the build caches and the
database need about 8 GB between them."
	fi
	if (( avail < 10 )); then
		warn "${avail} GB free; images and build caches take about 8 GB"
	else
		ok "${avail} GB free"
	fi
}

# The compiler is what needs the memory here, not the service: tsc and vite over React 19,
# CodeMirror and yjs, then a Go build. Below 2 GB the build is killed rather than slowed, and
# an OOM kill surfaces as exit code 137, which reads as Docker having broken.
check_memory() {
	local mem_kb swap_kb total_mb
	mem_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
	swap_kb=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)
	total_mb=$(( (mem_kb + swap_kb) / 1024 ))

	if (( total_mb >= 2048 )); then
		ok "${total_mb} MB of memory including swap"
		return
	fi
	if [[ -n $IMAGE ]]; then
		info "${total_mb} MB of memory, but nothing is compiled here: --image was given"
		return
	fi

	warn "${total_mb} MB of memory including swap. Compiling the frontend needs about 2 GB,
    and the build is killed rather than slowed when it runs out."

	case $SWAP_CHOICE in
	no)  warn "continuing without swap because --no-swap was given"; return ;;
	yes) ;;
	*)   confirm "Create a 2 GB swap file at /swapfile?" y || return ;;
	esac
	create_swapfile
}

create_swapfile() {
	if [[ -e /swapfile ]]; then
		warn "/swapfile already exists, leaving it alone"
		return
	fi
	step "creating /swapfile"
	# fallocate is instant on ext4 and xfs; dd is the fallback for filesystems where a
	# preallocated file cannot be swapped on, btrfs among them.
	fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
	chmod 600 /swapfile
	mkswap /swapfile >/dev/null
	swapon /swapfile
	grep -q '^/swapfile ' /etc/fstab || printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
	ok "2 GB of swap is on, and comes back after a reboot"
}

port_holder() {
	local port=$1
	if command -v ss >/dev/null; then
		ss -Hltnp "sport = :$port" 2>/dev/null | head -1
	elif command -v lsof >/dev/null; then
		lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}'
	fi
}

check_ports() {
	local port holder
	for port in 80 443; do
		holder=$(port_holder "$port")
		[[ -n $holder ]] || { ok "port $port is free"; continue; }
		# A re-run finds our own Caddy holding both, through docker-proxy.
		if [[ $holder == *docker-proxy* || $holder == *dockerd* ]] && installed; then
			info "port $port is held by this deployment's Caddy"
			continue
		fi
		die "port $port is already in use:
    $holder

Shelf needs 80 and 443 for the certificate and for the site. Stop whatever holds them, or
install behind it rather than in front of it."
	done
}

check_conflicting_servers() {
	local unit
	for unit in nginx apache2 httpd caddy; do
		systemctl is-active --quiet "$unit" 2>/dev/null || continue
		die "$unit is running on this host and will fight Caddy for ports 80 and 443.

    systemctl disable --now $unit"
	done
}

check_firewall() {
	if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
		# Docker publishes a port by writing DNAT rules that traverse FORWARD, while ufw filters
		# INPUT. The port is reachable whatever ufw says, which is worth knowing before someone
		# concludes their firewall is holding.
		info "ufw is active; Docker publishes its ports past it, so 80 and 443 will be reachable"
	fi
	if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
		warn "firewalld is active and Docker does integrate with it. If the site is unreachable:
    firewall-cmd --permanent --add-service=http --add-service=https && firewall-cmd --reload"
	fi
}

ensure_docker() {
	if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
		ok "docker $(docker version --format '{{.Server.Version}}') is running"
	else
		install_docker
	fi

	# Compose v2 is a plugin, not the docker-compose script. The v1 one cannot read this
	# project's compose file and has been out of support for years.
	if ! docker compose version >/dev/null 2>&1; then
		install_plugins || die "docker compose v2 is missing and could not be installed.

Docker is present but its Compose plugin is not, which is common where Docker came from the
distribution rather than from Docker's own repository. On Debian and Ubuntu:

    apt-get install -y docker-compose-plugin docker-buildx-plugin

Elsewhere: https://docs.docker.com/compose/install/linux/"
	fi

	# The Dockerfile caches its dependency downloads through RUN --mount=type=cache, which the
	# legacy builder refuses outright.
	if ! docker buildx version >/dev/null 2>&1 && [[ -z $IMAGE ]]; then
		install_plugins || die "docker buildx is missing, and the Dockerfile needs BuildKit.

    apt-get install -y docker-buildx-plugin

Or install a prebuilt image instead of compiling here, with --image."
	fi

	ok "compose $(docker compose version --short), buildx present"
}

install_docker() {
	case $OS_ID in
	debian|ubuntu|raspbian|centos|rhel|fedora|rocky|almalinux)
		step "installing Docker from get.docker.com"
		# Docker's own script rather than the distribution package: Debian 11 ships 20.10 with
		# neither the Compose plugin nor buildx, and those two are exactly what is needed here.
		# It installs Docker's apt repository, so updates arrive through the usual apt upgrade.
		curl -fsSL https://get.docker.com -o /tmp/get-docker.sh \
			|| die "could not download the Docker installer; check outbound HTTPS from this machine"
		sh /tmp/get-docker.sh >&2 || die "the Docker installer failed, its output is above"
		rm -f /tmp/get-docker.sh
		systemctl enable --now docker
		;;
	*)
		die "Docker is not installed and $OS_ID is not one this script installs it on.

Install Docker Engine with the Compose v2 and Buildx plugins, then run this again:
    https://docs.docker.com/engine/install/"
		;;
	esac
	docker info >/dev/null 2>&1 \
		|| die "Docker was installed but its daemon is not running: systemctl status docker"
}

install_plugins() {
	case $OS_ID in
	debian|ubuntu)
		DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
			docker-compose-plugin docker-buildx-plugin >/dev/null 2>&1
		;;
	*) return 1 ;;
	esac
}

public_address() {
	local endpoint address
	# Three services rather than one: any single one of them would be a hard dependency this
	# script has no business having.
	for endpoint in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
		address=$(curl -fsS --max-time 5 "$endpoint" 2>/dev/null | tr -d '[:space:]') || continue
		[[ -n $address ]] && { printf '%s' "$address"; return; }
	done
}

check_dns() {
	local resolved public
	# getent uses the host resolver, which is roughly what Let's Encrypt's resolver will agree
	# with, and it needs no dig on a minimal image.
	resolved=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}') || true

	if [[ -z $resolved ]]; then
		dns_problem "$DOMAIN does not resolve at all. Add an A record pointing at this machine
and give it a moment: Let's Encrypt reads the same DNS."
		return
	fi

	public=$(public_address)
	if [[ -z $public ]]; then
		warn "could not work out this machine's public address; skipping the DNS comparison"
		return
	fi
	if [[ $resolved == "$public" ]]; then
		ok "$DOMAIN resolves to $resolved, which is this machine"
		return
	fi
	dns_problem "$DOMAIN resolves to $resolved, but this machine answers from $public.
Let's Encrypt will come to $resolved on port 80 and find something else. That is expected
behind a proxy that terminates TLS for you, and a mistake otherwise."
}

dns_problem() {
	if (( SKIP_DNS_CHECK )); then
		warn "$1"
		warn "continuing because --skip-dns-check was given"
		return
	fi
	if (( INTERACTIVE )) && confirm "Continue anyway?" n; then
		warn "continuing; if no certificate is issued, this is the first thing to look at"
		return
	fi
	die "$1

Fix the record, or pass --skip-dns-check to install anyway and sort the certificate out later."
}

installed() { [[ -f $ENV_FILE ]]; }

# With `curl | bash` there is no script on disk: BASH_SOURCE holds "bash" or nothing. A readable
# file inside a checkout of this repository is the only thing that counts as running from a clone.
running_from_clone() {
	local src=${BASH_SOURCE[0]:-} dir
	[[ -f $src ]] || return 1
	dir=$(cd -- "$(dirname -- "$src")" && pwd -P) || return 1
	[[ -f $dir/go.mod && -f $dir/Dockerfile ]] || return 1
	grep -qx 'module shelf' "$dir/go.mod" || return 1
	printf '%s' "$dir"
}

# Settled before anything reads .env: an install run out of a checkout keeps its secrets in that
# checkout, not in whatever /opt/shelf happens to hold.
resolve_dir() {
	local clone
	if clone=$(running_from_clone); then
		if (( ! DIR_EXPLICIT )); then
			DIR=$clone
		fi
		if [[ $DIR == "$clone" ]]; then
			SKIP_GIT=1
		fi
	fi
	ENV_FILE="$DIR/.env"
}

obtain_sources() {
	if (( SKIP_GIT )); then
		ok "installing from the clone this script came from: $DIR"
		return
	fi

	if [[ -d $DIR/.git ]]; then
		update_clone
	elif [[ -e $DIR && -n $(ls -A "$DIR" 2>/dev/null) ]]; then
		die "$DIR exists and is neither empty nor a clone of this repository.
Move it aside, or install somewhere else with --dir."
	else
		step "cloning $REPO ($BRANCH) into $DIR"
		# Shallow: .dockerignore keeps .git out of the build context anyway, so the history buys
		# nothing here and costs most of the download.
		git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR" \
			|| die "clone failed. Check that $REPO is reachable and that '$BRANCH' exists on it."
		ok "cloned at $(git -C "$DIR" rev-parse --short HEAD)"
	fi
}

update_clone() {
	step "updating $DIR"
	local dirty
	# Tracked files only. .env and caddy.d/ are ignored, and a hard reset leaves untracked files
	# alone, so neither is ever at risk here.
	dirty=$(git -C "$DIR" status --porcelain --untracked-files=no)
	if [[ -n $dirty ]]; then
		printf '%s\n' "$dirty" >&2
		(( FORCE )) || die "$DIR has local changes to tracked files, listed above.

Local configuration belongs in $DIR/caddy.d/ and $DIR/.env, neither of which is tracked and
neither of which an update touches. To throw the changes above away, run again with --force."
		warn "discarding the local changes above, because --force was given"
	fi
	git -C "$DIR" fetch --depth 1 origin "$BRANCH" \
		|| die "could not reach $REPO to fetch $BRANCH"
	git -C "$DIR" reset --hard FETCH_HEAD >/dev/null
	ok "now at $(git -C "$DIR" rev-parse --short HEAD)"
}

ensure_caddy_dir() {
	local dir="$DIR/caddy.d"
	mkdir -p "$dir"
	if [[ -e $dir/README.caddy ]]; then
		return 0
	fi
	# Caddy fails to start on an import glob that matches nothing, so the directory is never
	# empty. Comments are a valid Caddyfile.
	cat >"$dir/README.caddy" <<'CADDY'
# Anything in this directory is imported into the site block of deploy/Caddyfile, in
# alphabetical order. The directory is not tracked by git, so what is written here survives an
# update instead of conflicting with one.
#
# A second name for the same site, for instance:
#
#   @alt host notes.example.org
#   handle @alt {
#       redir https://notes.example.com{uri} permanent
#   }
#
# After editing:  cd /opt/shelf && docker compose restart caddy
CADDY
}

env_value() {
	[[ -f $ENV_FILE ]] || return 0
	sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

secret() {
	if command -v openssl >/dev/null; then
		openssl rand -hex 32
	else
		# 64 hex characters, the same shape, without depending on openssl being installed.
		head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
	fi
}

# The password ends up inside a URL that the pool parses, and although the DSN builder escapes
# it, an alphabet with nothing to escape is one less thing that can go wrong in a place where
# the failure reads as "password authentication failed".
password() {
	# head first, then the filter: the other order leaves tr writing into a closed pipe, and
	# pipefail reports the SIGPIPE as a failure that takes the whole script with it.
	local raw
	raw=$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')
	printf '%s' "${raw:0:32}"
}

# A fixed constant risks colliding with a network that already exists, and Docker reports that
# as "Pool overlaps with other one on this address space", which diagnoses badly.
choose_subnet() {
	local existing candidate prefix
	existing=$(docker network ls -q 2>/dev/null \
		| xargs -r docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null \
		| tr ' ' '\n' | grep -v '^$' || true)

	for candidate in "${SUBNET_CANDIDATES[@]}"; do
		prefix=${candidate%.*.*}
		if grep -q "^${prefix}\." <<<"$existing"; then
			continue
		fi
		printf '%s' "$candidate"
		return
	done
	die "every candidate subnet (${SUBNET_CANDIDATES[*]}) collides with a network that already
exists here. Pick a free /16 by hand: put SHELF_DOCKER_SUBNET=10.90.0.0/16 in $ENV_FILE and
run this again with --update."
}

collect_answers() {
	local existing

	existing=$(env_value SHELF_DOMAIN)
	if [[ -z $DOMAIN && -n $existing ]]; then
		DOMAIN=$existing
	elif [[ -z $DOMAIN ]]; then
		ask "Domain this will be served on" "" DOMAIN
	elif [[ -n $existing && $existing != "$DOMAIN" ]]; then
		warn "this deployment was installed as $existing and is being changed to $DOMAIN.
    Every connector already registered against the old name will stop working."
		confirm "Change the domain?" n || die "left as $existing"
	fi

	existing=$(env_value ACME_EMAIL)
	if [[ -z $ACME_EMAIL && -n $existing ]]; then
		ACME_EMAIL=$existing
	elif [[ -z $ACME_EMAIL ]]; then
		ask "Email for Let's Encrypt expiry notices" "" ACME_EMAIL
	fi

	validate_domain

	if [[ -z $MCP ]]; then
		existing=$(env_value SHELF_MCP_ENABLED)
		if [[ -n $existing ]]; then
			[[ $existing == true ]] && MCP=1 || MCP=0
		elif confirm "Enable the Claude connector? (a vault connected to it is readable by this server)" n; then
			MCP=1
		else
			MCP=0
		fi
	fi

	[[ -n $IMAGE ]] || IMAGE=$(env_value SHELF_IMAGE)
	[[ -n $IMAGE ]] || IMAGE="shelf-app:local"
}

write_env() {
	step "writing $ENV_FILE"

	local auth_secret mcp_secret pg_password
	# Never regenerated. A new auth secret signs everybody out, and a new connector secret makes
	# every credential already in the database permanently unopenable.
	auth_secret=$(env_value SHELF_AUTH_SECRET); [[ -n $auth_secret ]] || auth_secret=$(secret)
	mcp_secret=$(env_value SHELF_MCP_SECRET);   [[ -n $mcp_secret ]]  || mcp_secret=$(secret)
	pg_password=$(env_value SHELF_POSTGRES_PASSWORD); [[ -n $pg_password ]] || pg_password=$(password)

	SUBNET=$(env_value SHELF_DOCKER_SUBNET)
	[[ -n $SUBNET ]] || SUBNET=$(choose_subnet)

	local mcp_enabled=false mcp_base=""
	if (( MCP )); then
		mcp_enabled=true
		mcp_base="https://$DOMAIN"
	fi

	local acme_ca=$ACME_CA
	[[ -n $acme_ca ]] || acme_ca=$(env_value ACME_CA)

	local tmp
	tmp=$(mktemp "$DIR/.env.XXXXXX")
	chmod 600 "$tmp"
	cat >"$tmp" <<ENV
# Shelf deployment configuration, written by install.sh $INSTALLER_VERSION on $(date -u +%FT%TZ).
#
# The secrets below exist nowhere else. Running install.sh again reads them back out of this
# file rather than generating new ones, because a new auth secret signs every session out and a
# new connector secret makes every key already in the database unopenable.
#
# Back this file up. Losing it costs more than losing the containers.

# --- how the compose commands find each other -------------------------------
# Named here so that a bare 'docker compose ps', run in this directory, reaches this deployment
# without a single flag.
COMPOSE_FILE=compose.prod.yml
COMPOSE_PROJECT_NAME=shelf

# --- deployment identity ----------------------------------------------------
SHELF_DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
# Empty means the Let's Encrypt production directory. The staging one, whose certificates no
# browser trusts and whose limits are generous, is:
#   $STAGING_CA
ACME_CA=$acme_ca

# The proxy's address range, and so the only source the application trusts an X-Forwarded-For
# from. Changing one without the other turns every per-address rate limit into a single bucket
# shared by the internet.
SHELF_DOCKER_SUBNET=$SUBNET

# Built here by default. Point this at a registry image and the install stops compiling.
SHELF_IMAGE=$IMAGE

# --- application ------------------------------------------------------------
SHELF_APP_ENV=prod
SHELF_LOG_LEVEL=info
SHELF_LOG_FORMAT=json
SHELF_HTTP_SWAGGER_ENABLED=false

# --- database ---------------------------------------------------------------
# initdb used these when the volume was created; editing them here changes nothing in Postgres
# and locks the application out of the database it already has.
SHELF_POSTGRES_USER=shelf
SHELF_POSTGRES_PASSWORD=$pg_password
SHELF_POSTGRES_DATABASE=shelf
SHELF_POSTGRES_SSL_MODE=disable
SHELF_POSTGRES_AUTO_MIGRATE=true

# --- secrets ----------------------------------------------------------------
# Signs access and refresh tokens. Replacing it signs everybody out; it loses no data.
SHELF_AUTH_SECRET=$auth_secret

# The Claude connector.
SHELF_MCP_ENABLED=$mcp_enabled
# Wraps the connector credentials at rest. Written whether or not the connector is on, so that
# turning it on later is a single change rather than two. There is no fallback and no recovery:
# replacing this makes every connector already attached to a vault permanently unreadable, and
# the failure reads as corruption rather than as a changed setting.
SHELF_MCP_SECRET=$mcp_secret
# Has to equal, byte for byte, the URL typed into Claude.
SHELF_MCP_PUBLIC_BASE_URL=$mcp_base
ENV
	mv -f "$tmp" "$ENV_FILE"
	chown root:root "$ENV_FILE"
	chmod 600 "$ENV_FILE"
	ok "$ENV_FILE (0600, root), subnet $SUBNET"
}

compose() {
	docker compose -f "$DIR/compose.prod.yml" --project-directory "$DIR" \
		--env-file "$ENV_FILE" -p shelf "$@"
}

bring_up() {
	step "building and starting"
	# Deliberately not quiet: this is five to fifteen minutes of compiling, and a silent
	# terminal for that long is indistinguishable from a hang.
	if [[ $IMAGE == shelf-app:local ]]; then
		compose up -d --build --remove-orphans || build_failed
	else
		compose up -d --pull always --remove-orphans || build_failed
	fi
	ok "containers are up"
}

build_failed() {
	local logs
	logs=$(compose logs --tail=40 app 2>/dev/null || true)
	if grep -qE 'exit code 137|Killed|heap out of memory' <<<"$logs$(dmesg 2>/dev/null | tail -20)"; then
		die "the build was killed, which on this machine means it ran out of memory.

Run again with --swap, or build the image somewhere else and install it with --image."
	fi
	die "the build or the start failed; the output above says where.

Common causes: no outbound HTTPS to registry.npmjs.org or proxy.golang.org, or a disk that
filled up mid-build. To see the build on its own:

    cd $DIR && docker compose build --progress plain app"
}

# wait_until <seconds> <description> <command...>
wait_until() {
	local deadline=$1 description=$2; shift 2
	local waited=0
	printf '  %s-%s waiting for %s' "$C_DIM" "$C_RESET" "$description" >&2
	while (( waited < deadline )); do
		if "$@" >/dev/null 2>&1; then
			printf '\r  %s+%s %s\033[K\n' "$C_GREEN" "$C_RESET" "$description" >&2
			return 0
		fi
		sleep 3
		waited=$(( waited + 3 ))
		printf '.' >&2
	done
	printf '\r  %s!%s %s — gave up after %ss\033[K\n' "$C_RED" "$C_RESET" "$description" "$deadline" >&2
	return 1
}

verify() {
	step "verifying"

	local pg_user pg_db
	pg_user=$(env_value SHELF_POSTGRES_USER)
	pg_db=$(env_value SHELF_POSTGRES_DATABASE)
	wait_until 120 "postgres accepting connections" \
		compose exec -T postgres pg_isready -U "$pg_user" -d "$pg_db" || fail_postgres

	# From inside the network, and from the caddy container rather than the app one: the app
	# image is distroless, so there is no shell and no wget in it to run this with.
	wait_until 180 "the application answering /ready" \
		compose exec -T caddy wget -q -O /dev/null -T 3 "http://app:8080/ready" || fail_app

	# One request that proves DNS, the certificate and the proxy at once: curl without -k
	# succeeding means the chain validates against the system store.
	wait_until 300 "https://$DOMAIN over a trusted certificate" \
		curl -fsS --max-time 10 -o /dev/null "https://$DOMAIN/health" || fail_tls

	local code
	code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://$DOMAIN/health" 2>/dev/null || echo 000)
	if [[ $code == 308 || $code == 301 ]]; then
		ok "http redirects to https ($code)"
	else
		warn "http://$DOMAIN answered $code rather than a redirect"
	fi

	if (( MCP )); then
		verify_connector
	fi
}

verify_connector() {
	local metadata
	metadata=$(curl -fsS --max-time 10 "https://$DOMAIN/.well-known/oauth-protected-resource" 2>/dev/null) \
		|| die "the connector is on, but its discovery document is not being served.
    cd $DIR && docker compose logs app"

	if grep -q "\"resource\":\"https://$DOMAIN/api/v1/mcp\"" <<<"$metadata"; then
		ok "the connector advertises https://$DOMAIN/api/v1/mcp"
	else
		die "the connector metadata does not name this domain:

$metadata

SHELF_MCP_PUBLIC_BASE_URL in $ENV_FILE has to be exactly https://$DOMAIN"
	fi

	if curl -fsS --max-time 10 "https://$DOMAIN/api/v1/features" 2>/dev/null | grep -q '"connector":true'; then
		ok "the connector routes are mounted"
	else
		die "the connector is configured but its routes are not mounted.
    cd $DIR && docker compose logs app"
	fi
}

fail_postgres() {
	compose logs --tail=40 postgres >&2 || true
	die "Postgres never became healthy; its last lines are above.

The usual cause on a re-install is a volume created with a different password. Either restore
the old SHELF_POSTGRES_PASSWORD in $ENV_FILE, or start over with
'cd $DIR && docker compose down -v' — which deletes every note in it."
}

fail_app() {
	local logs
	logs=$(compose logs --tail=80 app 2>/dev/null || true)
	printf '%s\n' "$logs" >&2

	if grep -q 'password authentication failed' <<<"$logs"; then
		die "the database rejected the password: this volume was created with a different one.
Restore the old SHELF_POSTGRES_PASSWORD in $ENV_FILE, or delete the volume and start over
with 'cd $DIR && docker compose down -v' — which deletes every note in it."
	fi
	if grep -q 'auth.secret is required' <<<"$logs"; then
		die "the service did not receive SHELF_AUTH_SECRET, so $ENV_FILE was not read.
Check that it is where compose expects it: $ENV_FILE"
	fi
	if grep -q 'mcp.secret is required\|mcp.public_base_url is required' <<<"$logs"; then
		die "the connector is on but incompletely configured; SHELF_MCP_SECRET and
SHELF_MCP_PUBLIC_BASE_URL both have to be set in $ENV_FILE."
	fi
	if grep -qi 'schema is dirty' <<<"$logs"; then
		die "the schema is dirty: a migration failed halfway and nothing can tell how far it
got. This needs a look before anything else — see the Migrations section of the README."
	fi
	if grep -q 'but this binary only carries' <<<"$logs"; then
		die "the database is ahead of this image, which is what a rollback past a migration
looks like. Install the newer version again, or restore the database from before it."
	fi
	die "the application never became ready; its last lines are above."
}

fail_tls() {
	local logs
	logs=$(compose logs --tail=60 caddy 2>/dev/null | grep -iE 'acme|certificate|error' | tail -20 || true)
	if [[ -n $logs ]]; then
		printf '%s\n' "$logs" >&2
	fi

	die "no working certificate for $DOMAIN yet.

Three things cause this, in order of how often:
  - the A record points somewhere else. Let's Encrypt reads DNS, not this machine
  - port 80 is not reachable from the internet. Nothing runnable from here proves that it is
  - the rate limit is spent. Let's Encrypt allows five failures an hour for one name; wait,
    or run again with --staging while the DNS is sorted out

    cd $DIR && docker compose logs caddy"
}

summary() {
	local mcp_lines=""
	if (( MCP )); then
		mcp_lines="
  The connector is on. In Claude, add:  https://$DOMAIN/api/v1/mcp
  SHELF_MCP_SECRET in $ENV_FILE unwraps every connector credential in the database. There is
  no copy of it anywhere else and nothing derives it again: if it is lost, every connector
  has to be attached again.
"
	fi

	cat >&2 <<SUMMARY

$C_GREEN$C_BOLD  Shelf is running at https://$DOMAIN$C_RESET

  Open it and make the first account. There is no invitation step and no administrator account
  to create first: whoever reaches /signup makes one.

  Registration is open to anyone who can reach that address, and there is no setting that
  closes it. If this should not be joinable by anyone who finds it, put something in front of
  it that decides who reaches it at all.
$mcp_lines
  $ENV_FILE holds the three secrets this deployment cannot be recovered without. Back it up.

  cd $DIR, then:

    docker compose logs -f app       # follow the service
    docker compose logs -f caddy     # TLS and access
    docker compose ps                # what is running
    docker compose restart app       # restart without rebuilding

  Update:     curl -fsSL $(raw_url) | sudo bash -s -- --update
  Uninstall:  curl -fsSL $(raw_url) | sudo bash -s -- --uninstall

SUMMARY
}

raw_url() {
	local slug=${REPO#*github.com[:/]}
	slug=${slug%.git}
	printf 'https://raw.githubusercontent.com/%s/%s/install.sh' "$slug" "$BRANCH"
}

uninstall() {
	installed || die "no installation found at $DIR"
	DOMAIN=$(env_value SHELF_DOMAIN)

	if (( PURGE )); then
		cat >&2 <<PURGE

This removes, permanently:
  the containers
  ${C_RED}the database volume — every note and every account${C_RESET}
  the certificate volume — Let's Encrypt allows five reissues a week for one name
  $DIR and everything in it, including .env and the secrets nothing can regenerate

PURGE
		(( INTERACTIVE )) || die "--purge deletes data and needs a terminal to confirm on."
		printf '  Type the domain (%s) to confirm: ' "$DOMAIN" >&2
		local typed; read -r typed <&3 || typed=""
		[[ $typed == "$DOMAIN" ]] || die "that is not the domain; nothing was removed"
		compose down -v --remove-orphans
		rm -rf -- "$DIR"
		ok "removed"
		return
	fi

	cat >&2 <<KEEP

This stops and removes the containers. The database and the certificates stay in their
volumes and $DIR stays on disk, so installing again picks up where this left off.
Add --purge to remove those too.

KEEP
	confirm "Continue?" n || die "nothing was removed"
	compose down --remove-orphans
	ok "stopped. Docker and any swap file this script created were left alone."
}

main() {
	setup_colors
	trap 'on_error $LINENO' ERR
	parse_args "$@"
	setup_tty
	require_root

	printf '%s%sShelf installer %s%s\n' "$C_BOLD" "$C_BLUE" "$INSTALLER_VERSION" "$C_RESET" >&2

	if [[ $MODE == uninstall ]]; then
		uninstall
		return
	fi

	resolve_dir

	step "checking this machine"
	detect_os
	ensure_base_tools
	check_disk
	check_conflicting_servers
	ensure_docker
	check_ports
	check_firewall

	if [[ $MODE == update ]]; then
		installed || die "no installation found at $DIR. Run without --update to install."
	fi

	collect_answers
	[[ $MODE == update ]] || check_dns
	check_memory

	obtain_sources
	ensure_caddy_dir
	write_env
	bring_up
	verify
	summary
}

main "$@"
