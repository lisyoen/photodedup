#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:-}"
SOURCE_ROOT="$(git rev-parse --show-toplevel)"
PUBLIC_ROOT="${PUBLIC_ROOT:-$HOME/projects/photodedup-public}"
TODAY="$(date +%F)"
MESSAGE="Release ${VERSION:-snapshot $TODAY}"
FORBIDDEN_PATTERN="$(printf '%s' '/home/lisyo' 'en|spark-' 'home|craft' 'bay|claude' 'q|open' 'claw|192\.168\.')"

cd "$SOURCE_ROOT"

if [[ -n "$(git status -s)" ]]; then
  echo "Development repository has uncommitted changes; aborting." >&2
  git status -s >&2
  exit 1
fi

if [[ ! -d "$PUBLIC_ROOT/.git" ]]; then
  echo "Public repository clone not found at $PUBLIC_ROOT" >&2
  exit 1
fi

rsync -a --delete \
  --exclude='.git/' \
  --exclude='archive/' \
  --exclude='in-progress/' \
  --exclude='work-reports/' \
  --exclude='scripts/homepc/' \
  --exclude='docs/deployment-history.md' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='build/' \
  --exclude='out/' \
  --exclude='.venv/' \
  --exclude='engine/.venv/' \
  --exclude='__pycache__/' \
  --exclude='*.log' \
  --exclude='.env*' \
  --exclude='shell/resources/sidecar/' \
  --exclude='shell/release/' \
  "$SOURCE_ROOT/" "$PUBLIC_ROOT/"

set +e
GATE_OUTPUT="$(grep -rnIE "$FORBIDDEN_PATTERN" "$PUBLIC_ROOT" --exclude-dir=.git)"
GATE_STATUS=$?
set -e

if [[ "$GATE_STATUS" -eq 0 ]]; then
  echo "Forbidden term gate failed:"
  printf '%s\n' "$GATE_OUTPUT"
  exit 1
fi

if [[ "$GATE_STATUS" -gt 1 ]]; then
  echo "Forbidden term gate command failed with status $GATE_STATUS" >&2
  exit "$GATE_STATUS"
fi

echo "Forbidden term gate: 0 matches"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN=1; export completed without commit or push."
  exit 0
fi

cd "$PUBLIC_ROOT"
git add -A
if git diff --cached --quiet; then
  echo "No public changes to commit."
else
  git commit -m "$MESSAGE"
  git push origin main
fi

if [[ -n "$VERSION" ]]; then
  git tag "$VERSION"
  git push origin "$VERSION"
fi
