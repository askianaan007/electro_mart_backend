#!/usr/bin/env bash
# Refuses to continue unless DATABASE_URL (and DIRECT_URL, if set) point at
# the serial-tracking test copy. Production is ep-icy-boat; the test copy is
# ep-bold-voice. Source the URL from .env.serials-test, never from .env.
set -euo pipefail
check() {
  local name="$1" value="${2:-}"
  [ -z "$value" ] && return 0
  case "$value" in
    *ep-icy-boat*) echo "REFUSED: $name points at PRODUCTION (ep-icy-boat)" >&2; exit 1 ;;
    *ep-bold-voice*) ;;
    *) echo "REFUSED: $name is not the serial test copy (ep-bold-voice)" >&2; exit 1 ;;
  esac
}
[ -z "${DATABASE_URL:-}" ] && { echo "REFUSED: DATABASE_URL is not set in the shell (prisma would fall back to .env = production)" >&2; exit 1; }
check DATABASE_URL "$DATABASE_URL"
check DIRECT_URL "${DIRECT_URL:-}"
echo "OK: target is the serial test copy ($(printf '%s' "$DATABASE_URL" | sed -E 's#.*@([^/]+).*#\1#'))"
