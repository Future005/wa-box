#!/bin/sh
# WA Box: set up and start a local copy (Mac / Linux). Safe to run again.
#   sh scripts/setup.sh
# Optional, before running:  ADMIN_USER=you@example.com ORG_NAME="Acme" GROUP_KEYWORDS="Cohort,Batch" PORT=3000
set -eu
cd "$(dirname "$0")/.."

say()  { printf '\033[1;36m›\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# 1. Docker
command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker Desktop (Mac/Windows) or Docker Engine (Linux): https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is missing. Update Docker Desktop, or install the docker-compose-plugin package."
docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Open Docker Desktop (or: sudo systemctl start docker) and run this again."

# 2. .env with fresh secrets (never overwrites an existing one)
if [ ! -f .env ]; then
  say "Making .env with a fresh engine key"
  if command -v openssl >/dev/null 2>&1; then KEY=$(openssl rand -hex 32); else KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'); fi
  sed -e "s|^WA_ENGINE_KEY=.*|WA_ENGINE_KEY=$KEY|" \
      -e "s|^ADMIN_USER=.*|ADMIN_USER=${ADMIN_USER:-admin}|" \
      -e "s|^ORG_NAME=.*|ORG_NAME=${ORG_NAME:-}|" \
      -e "s|^GROUP_KEYWORDS=.*|GROUP_KEYWORDS=${GROUP_KEYWORDS:-}|" \
      -e "s|^PORT=.*|PORT=${PORT:-3000}|" .env.example > .env
  chmod 600 .env
else
  say "Using the existing .env"
fi
PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-3000}

# 3. Port free?
if ! docker compose -f docker-compose.local.yml ps --status running 2>/dev/null | grep -q wabox; then
  if (command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1); then
    fail "Port $PORT is already in use. Set PORT=3005 (for example) in .env and run this again."
  fi
fi

# 4. Build (this also runs the safety tests) and start
say "Building and starting. The first time takes 3-10 minutes (it downloads Chrome for the WhatsApp engine)."
docker compose -f docker-compose.local.yml up -d --build

# 5. Wait until it answers
say "Waiting for WA Box to answer on http://localhost:$PORT"
i=0
until curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1; do
  i=$((i+1)); [ $i -gt 90 ] && fail "WA Box didn't start in 3 minutes. See: docker compose -f docker-compose.local.yml logs wabox"
  sleep 2
done

USER_NAME=$(grep -E '^ADMIN_USER=' .env | cut -d= -f2)
ONE_TIME=$(docker compose -f docker-compose.local.yml logs wabox 2>/dev/null | sed -n 's/.*One-time password: //p' | tail -1)
echo
printf '\033[1;32m✓ WA Box is running\033[0m\n'
echo "  Open:      http://localhost:$PORT"
echo "  Username:  ${USER_NAME:-admin}"
if [ -n "$ONE_TIME" ]; then echo "  Password:  $ONE_TIME   (one-time; you'll choose your own after signing in)"
else echo "  Password:  the ADMIN_PASSWORD in .env, or the one you already chose"; fi
echo
echo "  It starts in practice mode: nothing reaches WhatsApp until you press \"Go live\"."
echo "  Next: WhatsApp & groups → scan the QR code with WhatsApp on your phone (Linked devices)."
echo "  Stop: docker compose -f docker-compose.local.yml down    (your data stays)"
