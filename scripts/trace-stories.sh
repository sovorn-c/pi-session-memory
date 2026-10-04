#!/usr/bin/env bash
# story: e01s05
# Traceability wrapper adapted from Bigpowers 2.88.9; see scripts/lib/UPSTREAM.md.
# scenario: SC-e01s05-P0-01 SC-e01s05-P0-02
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENGINE="$SCRIPT_DIR/lib/trace-stories.py"
MODE=""
STRICT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      cat <<'USAGE'
Usage: trace-stories.sh [--strict] [--json] [--help]

Build the Bigpowers spec-to-code traceability matrix for this repository.
The repository root is resolved from this script's location, not the caller's
working directory. --json writes specs/traceability-matrix.json.

Exit codes: 0=generated, 1=invalid/missing input or runtime, 2=--strict anti-vacuity
baseline not met or an eligible P0 story has zero links.
USAGE
      exit 0
      ;;
    --strict) STRICT=1; shift ;;
    --json) MODE="json"; shift ;;
    *)
      echo "trace-stories.sh: unknown flag: $1" >&2
      echo "Try --help for usage." >&2
      exit 1
      ;;
  esac
done

RELEASE_PLAN="$REPO_ROOT/specs/release-plan.yaml"
EXEC_STATUS="$REPO_ROOT/specs/execution-status.yaml"
MATRIX_JSON="$REPO_ROOT/specs/traceability-matrix.json"
TRACE_MD="$REPO_ROOT/specs/TRACEABILITY_LATEST.md"
OKF_DIR="$REPO_ROOT/specs/codebase-wiki"
check_output_paths() {
  if [[ -L "$REPO_ROOT/specs" ]]; then
    echo "trace-stories.sh: refusing symlinked specs directory: $REPO_ROOT/specs" >&2
    return 1
  fi
  for output in "$MATRIX_JSON" "$TRACE_MD"; do
    if [[ -L "$output" ]]; then
      echo "trace-stories.sh: refusing symlinked generated output: $output" >&2
      return 1
    fi
    if [[ -e "$output" && ! -f "$output" ]]; then
      echo "trace-stories.sh: refusing non-file generated output: $output" >&2
      return 1
    fi
  done
  if [[ -L "$OKF_DIR" ]]; then
    echo "trace-stories.sh: refusing symlinked codebase-wiki output directory: $OKF_DIR" >&2
    return 1
  fi
  if [[ -e "$OKF_DIR" && ! -d "$OKF_DIR" ]]; then
    echo "trace-stories.sh: refusing non-directory codebase-wiki output path: $OKF_DIR" >&2
    return 1
  fi
  if [[ -d "$OKF_DIR" ]]; then
    SYMLINK_OUTPUT="$(find "$OKF_DIR" -type l -print -quit)"
    if [[ -n "$SYMLINK_OUTPUT" ]]; then
      echo "trace-stories.sh: refusing symlinked generated output: $SYMLINK_OUTPUT" >&2
      return 1
    fi
    for output in "$OKF_DIR"/index.md "$OKF_DIR"/e??s??.md; do
      if [[ -e "$output" && ! -f "$output" ]]; then
        echo "trace-stories.sh: refusing non-file generated output: $output" >&2
        return 1
      fi
    done
  fi
}

invalidate_generated_outputs() {
  check_output_paths || return 1
  rm -f "$MATRIX_JSON" "$TRACE_MD"
  if [[ -d "$OKF_DIR" ]]; then
    for output in "$OKF_DIR"/index.md "$OKF_DIR"/e??s??.md; do
      name="${output##*/}"
      if [[ "$name" == "index.md" || "$name" =~ ^e[0-9]{2}s[0-9]{2}\.md$ ]]; then
        rm -f "$output"
      fi
    done
  fi
}

# Clear the complete generated result set before validating or executing a new run.
invalidate_generated_outputs || exit 1
for input in "$RELEASE_PLAN" "$EXEC_STATUS"; do
  if [[ ! -f "$input" ]]; then
    echo "trace-stories.sh: required input not found: $input" >&2
    exit 1
  fi
done
if [[ ! -f "$ENGINE" ]]; then
  echo "trace-stories.sh: engine not found: $ENGINE" >&2
  exit 1
fi

PYTHON="${PI_SESSION_MEMORY_PYTHON:-python3.11}"
if [[ "$PYTHON" == */* ]]; then
  if [[ ! -x "$PYTHON" ]]; then
    echo "trace-stories.sh: Python executable is not runnable: $PYTHON" >&2
    exit 1
  fi
elif ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "trace-stories.sh: Python executable not found: $PYTHON" >&2
  exit 1
fi
if ! "$PYTHON" -c 'import yaml' >/dev/null 2>&1; then
  echo "trace-stories.sh: PyYAML is required; select the pinned environment with PI_SESSION_MEMORY_PYTHON." >&2
  exit 1
fi

export PYTHONDONTWRITEBYTECODE="${PYTHONDONTWRITEBYTECODE:-1}"
if "$PYTHON" "$ENGINE" \
  "$REPO_ROOT" "$MATRIX_JSON" "$TRACE_MD" "$OKF_DIR" "$STRICT" "$MODE"; then
  exit 0
else
  status=$?
  invalidate_generated_outputs || true
  exit "$status"
fi
