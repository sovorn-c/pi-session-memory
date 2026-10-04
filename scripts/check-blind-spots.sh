#!/usr/bin/env bash
# story: e01s05
# Blind-spot wrapper adapted from Bigpowers 2.88.9; see scripts/lib/UPSTREAM.md.
# scenario: SC-e01s05-P0-01 SC-e01s05-P0-02 SC-e01s05-P0-03
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENGINE="$SCRIPT_DIR/lib/blind-spots.py"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      cat <<'USAGE'
Usage: check-blind-spots.sh [--help]

Run the official Bigpowers 2.88.9 structural quality checks for this
repository. The repository root is resolved from this script's location.

Checks: verify-gap, test-gap, epic-orphan, stale-tag, double-tag,
bootstrap-testless, sc-gap. Exit 0 when there are no HIGH findings; exit 1 on
HIGH findings or missing required inputs.
USAGE
      exit 0
      ;;
    *)
      echo "check-blind-spots.sh: unknown flag: $1" >&2
      echo "Try --help for usage." >&2
      exit 1
      ;;
  esac
done

EXEC_STATUS="$REPO_ROOT/specs/execution-status.yaml"
MATRIX_JSON="$REPO_ROOT/specs/traceability-matrix.json"
BLIND_SPOTS_JSON="$REPO_ROOT/specs/blind-spots.json"
VERIFICATIONS_DIR="$REPO_ROOT/specs/verifications"
EPICS_DIR="$REPO_ROOT/specs/epics"
if [[ -L "$REPO_ROOT/specs" ]]; then
  echo "check-blind-spots.sh: refusing symlinked specs directory: $REPO_ROOT/specs" >&2
  exit 1
fi
if [[ -L "$BLIND_SPOTS_JSON" ]]; then
  echo "check-blind-spots.sh: refusing symlinked blind-spot output path: $BLIND_SPOTS_JSON" >&2
  exit 1
fi
# A failed attempt must not leave a stale blind-spot report for the critic.
rm -f "$BLIND_SPOTS_JSON"
for input in "$EXEC_STATUS" "$MATRIX_JSON"; do
  if [[ ! -f "$input" ]]; then
    echo "check-blind-spots.sh: required input not found: $input" >&2
    exit 1
  fi
done
if [[ ! -f "$ENGINE" ]]; then
  echo "check-blind-spots.sh: engine not found: $ENGINE" >&2
  exit 1
fi

PYTHON="${PI_SESSION_MEMORY_PYTHON:-python3.11}"
if [[ "$PYTHON" == */* ]]; then
  if [[ ! -x "$PYTHON" ]]; then
    echo "check-blind-spots.sh: Python executable is not runnable: $PYTHON" >&2
    exit 1
  fi
elif ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "check-blind-spots.sh: Python executable not found: $PYTHON" >&2
  exit 1
fi
if ! "$PYTHON" -c 'import yaml' >/dev/null 2>&1; then
  echo "check-blind-spots.sh: PyYAML is required; select the pinned environment with PI_SESSION_MEMORY_PYTHON." >&2
  exit 1
fi

export PYTHONDONTWRITEBYTECODE="${PYTHONDONTWRITEBYTECODE:-1}"
exec "$PYTHON" "$ENGINE" \
  "$REPO_ROOT" "$BLIND_SPOTS_JSON" "$EXEC_STATUS" "$MATRIX_JSON" "$VERIFICATIONS_DIR" "$EPICS_DIR"
