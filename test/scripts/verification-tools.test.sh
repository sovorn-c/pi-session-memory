#!/usr/bin/env bash
# story: e01s05
# scenario: SC-e01s05-P0-01 SC-e01s05-P0-02 SC-e01s05-P0-03 SC-e01s05-P0-04
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON="${PI_SESSION_MEMORY_PYTHON:-python3.11}"
if [[ "$PYTHON" == */* ]]; then
  [[ -x "$PYTHON" ]] || { echo "Python executable not runnable: $PYTHON" >&2; exit 1; }
elif ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "Python executable not found: $PYTHON" >&2
  exit 1
fi
"$PYTHON" -c 'import yaml' >/dev/null 2>&1 || {
  echo "PyYAML is required; set PI_SESSION_MEMORY_PYTHON to the pinned environment." >&2
  exit 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local file="$1" text="$2"
  grep -Fq "$text" "$file" || fail "expected '$text' in $file"
}

make_fixture() {
  local root="$1" wsjf="$2"
  mkdir -p "$root"
  cp -R "$REPO_ROOT/scripts" "$root/"
  mkdir -p "$root/test/scripts" \
    "$root/specs/epics/e01-fixture" \
    "$root/specs/verifications"
  cp "$REPO_ROOT/test/scripts/verification-tools.test.sh" "$root/test/scripts/"
  cat > "$root/specs/release-plan.yaml" <<YAML
epics:
  - id: e01
    title: Fixture verification
    bcps: 1
    wsjf: $wsjf
    capsule_dir: epics/e01-fixture
YAML
  cat > "$root/specs/execution-status.yaml" <<'YAML'
development_status:
  e01s05: "active"
YAML
  cat > "$root/specs/epics/e01-fixture/epic.yaml" <<'YAML'
stories:
  - id: e01s05
    title: Run official completeness gates
    bcp: 1
    description: Fixture story for repository-root verification.
YAML
  cat > "$root/specs/epics/e01-fixture/e01s05-tasks.yaml" <<'YAML'
story_id: e01s05
status: failing
tasks:
  - id: 1
    verify: bash test/scripts/verification-tools.test.sh
YAML
  cat > "$root/specs/verifications/e01s05-verify.yaml" <<'YAML'
story_id: e01s05
verified_at: "fixture"
YAML
  cat > "$root/specs/state.yaml" <<'YAML'
active_story: e01s05
YAML
}

assert_blind_status_rejected() {
  local name="$1" status_content="$2" expected="$3" root="$TMP/$1"
  make_fixture "$root" '{score: 1}'
  PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$root/scripts/trace-stories.sh" --json > /dev/null 2>&1 \
    || fail "could not generate matrix for $name status case"
  PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$root/scripts/check-blind-spots.sh" > /dev/null 2>&1 \
    || fail "could not seed blind-spot output for $name status case"
  printf '%s\n' "$status_content" > "$root/specs/execution-status.yaml"
  if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$root/scripts/check-blind-spots.sh" > "$TMP/$name.out" 2>&1; then
    fail "blind-spot checker accepted $name execution status"
  fi
  assert_contains "$TMP/$name.out" "$expected"
  [[ ! -e "$root/specs/blind-spots.json" ]] || fail "$name status left stale blind-spot evidence"
}

GOOD="$TMP/project"
make_fixture "$GOOD" '{score: 1}'

# Run from outside the fixture root: paths and generated artifacts must still
# be anchored to the copied project's scripts directory.
cd "$TMP"
assert_contains <(PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$GOOD/scripts/trace-stories.sh" --help) 'Usage: trace-stories.sh'
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$GOOD/scripts/trace-stories.sh" --not-a-flag > "$TMP/trace-bad-flag.out" 2>&1; then
  fail "trace wrapper accepted an unknown CLI flag"
fi
assert_contains "$TMP/trace-bad-flag.out" 'unknown flag'
assert_contains <(PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$GOOD/scripts/check-blind-spots.sh" --help) 'Usage: check-blind-spots.sh'
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$GOOD/scripts/check-blind-spots.sh" --not-a-flag > "$TMP/blind-bad-flag.out" 2>&1; then
  fail "blind-spot wrapper accepted an unknown CLI flag"
fi
assert_contains "$TMP/blind-bad-flag.out" 'unknown flag'
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$GOOD/scripts/trace-stories.sh" --json > "$TMP/trace.out" 2>&1 \
  || { cat "$TMP/trace.out" >&2; fail "trace generation failed from a foreign cwd"; }
[[ -f "$GOOD/specs/traceability-matrix.json" ]] || fail "matrix not written under project root"
[[ -f "$GOOD/specs/TRACEABILITY_LATEST.md" ]] || fail "trace report not written under project root"
[[ -f "$GOOD/specs/codebase-wiki/e01s05.md" ]] || fail "OKF output not written under project root"
assert_contains "$GOOD/specs/traceability-matrix.json" '"id": "e01s05"'
assert_contains "$GOOD/specs/traceability-matrix.json" '"wsjf": 1.0'

STALE_WIKI="$TMP/stale-wiki"
make_fixture "$STALE_WIKI" '{score: 1}'
cat >> "$STALE_WIKI/specs/epics/e01-fixture/epic.yaml" <<'YAML'
  - id: e01s06
    title: Second fixture story
    bcp: 1
    description: A second generated wiki page.
YAML
printf 'development_status:\n  e01s05: active\n  e01s06: active\n' > "$STALE_WIKI/specs/execution-status.yaml"
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$STALE_WIKI/scripts/trace-stories.sh" --json > "$TMP/stale-wiki-seed.out" 2>&1 \
  || { cat "$TMP/stale-wiki-seed.out" >&2; fail "could not generate wiki outputs for invalidation case"; }
for generated in traceability-matrix.json TRACEABILITY_LATEST.md codebase-wiki/index.md codebase-wiki/e01s05.md codebase-wiki/e01s06.md; do
  [[ -f "$STALE_WIKI/specs/$generated" ]] || fail "successful trace did not generate $generated"
done
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$STALE_WIKI/scripts/trace-stories.sh" --strict --json > "$TMP/stale-wiki-engine-failure.out" 2>&1; then
  fail "strict engine failure returned success"
fi
assert_contains "$TMP/stale-wiki-engine-failure.out" 'STRICT FAIL — story count'
for generated in traceability-matrix.json TRACEABILITY_LATEST.md codebase-wiki/index.md codebase-wiki/e01s05.md codebase-wiki/e01s06.md; do
  [[ ! -e "$STALE_WIKI/specs/$generated" ]] || fail "strict engine failure left generated output $generated"
done
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$STALE_WIKI/scripts/trace-stories.sh" --json > "$TMP/stale-wiki-reseed.out" 2>&1 \
  || { cat "$TMP/stale-wiki-reseed.out" >&2; fail "could not regenerate wiki outputs after engine failure"; }
printf 'epics: [\n' > "$STALE_WIKI/specs/release-plan.yaml"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$STALE_WIKI/scripts/trace-stories.sh" --json > "$TMP/stale-wiki-invalid.out" 2>&1; then
  fail "trace generator accepted malformed input after producing wiki outputs"
fi
for generated in traceability-matrix.json TRACEABILITY_LATEST.md codebase-wiki/index.md codebase-wiki/e01s05.md codebase-wiki/e01s06.md; do
  [[ ! -e "$STALE_WIKI/specs/$generated" ]] || fail "invalid trace run left stale generated output $generated"
done

if PI_SESSION_MEMORY_PYTHON="$TMP/not-a-python" bash "$GOOD/scripts/trace-stories.sh" --json > "$TMP/missing-python.out" 2>&1; then
  fail "trace generator accepted a missing Python executable"
fi
assert_contains "$TMP/missing-python.out" 'Python executable is not runnable'
[[ ! -e "$GOOD/specs/traceability-matrix.json" ]] || fail "missing Python left a stale trace matrix"
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$GOOD/scripts/trace-stories.sh" --json > /dev/null 2>&1 \
  || fail "could not regenerate trace matrix after missing-Python case"

SCALAR="$TMP/scalar"
make_fixture "$SCALAR" '1'
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$SCALAR/scripts/trace-stories.sh" --json > "$TMP/scalar.out" 2>&1 \
  || { cat "$TMP/scalar.out" >&2; fail "upstream scalar WSJF input failed"; }
assert_contains "$SCALAR/specs/traceability-matrix.json" '"wsjf": 1.0'

PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$GOOD/scripts/check-blind-spots.sh" > "$TMP/blind.out" 2>&1 \
  || { cat "$TMP/blind.out" >&2; fail "blind-spot check failed on valid fixture"; }
[[ -f "$GOOD/specs/blind-spots.json" ]] || fail "blind-spot report not written under project root"
if PI_SESSION_MEMORY_PYTHON="$TMP/not-a-python" bash "$GOOD/scripts/check-blind-spots.sh" > "$TMP/missing-blind-python.out" 2>&1; then
  fail "blind-spot checker accepted a missing Python executable"
fi
assert_contains "$TMP/missing-blind-python.out" 'Python executable is not runnable'
[[ ! -e "$GOOD/specs/blind-spots.json" ]] || fail "missing Python left stale blind-spot evidence"
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$GOOD/scripts/check-blind-spots.sh" > /dev/null 2>&1 \
  || fail "could not regenerate blind-spot report after missing-Python case"

bash "$GOOD/scripts/lib/completeness-critic.sh" > "$TMP/critic.out" 2>&1 \
  || { cat "$TMP/critic.out" >&2; fail "completeness critic blocked valid fixture"; }
assert_contains "$TMP/critic.out" '[FILLED] Trace coverage 100.0% meets 80% PASS bar'
assert_contains "$TMP/critic.out" 'completeness-critic: BLOCKER=0'

cp "$GOOD/specs/traceability-matrix.json" "$TMP/valid-matrix.json"
for invalid_stories in '[]' '[null]' '[{}]'; do
  printf '{"stories":%s,"summary":{}}\n' "$invalid_stories" > "$GOOD/specs/traceability-matrix.json"
  if bash "$GOOD/scripts/lib/completeness-critic.sh" > "$TMP/critic-bad-stories.out" 2>&1; then
    fail "completeness critic accepted malformed story inventory: $invalid_stories"
  fi
  assert_contains "$TMP/critic-bad-stories.out" 'Malformed specs/traceability-matrix.json — expected a non-empty, well-formed stories inventory and summary'
  assert_contains "$TMP/critic-bad-stories.out" 'BLOCKER=1'
done
mv "$TMP/valid-matrix.json" "$GOOD/specs/traceability-matrix.json"

# A structurally incomplete story must not become a successful empty-link report.
for mutation in missing-links null-links object-links invalid-link blank-file invalid-line invalid-confidence missing-method invalid-id duplicate-id missing-status; do
  INVALID_STORY="$TMP/story-$mutation"
  make_fixture "$INVALID_STORY" '{score: 1}'
  PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$INVALID_STORY/scripts/trace-stories.sh" --json > /dev/null 2>&1 \
    || fail "could not generate matrix for $mutation"
  PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$INVALID_STORY/scripts/check-blind-spots.sh" > /dev/null 2>&1 \
    || fail "could not seed report for $mutation"
  "$PYTHON" - "$INVALID_STORY/specs/traceability-matrix.json" "$mutation" <<'PY'
import json, sys
from pathlib import Path
path, mutation = Path(sys.argv[1]), sys.argv[2]
data = json.loads(path.read_text())
story = data['stories'][0]
if mutation == 'missing-links': del story['links']
elif mutation == 'null-links': story['links'] = None
elif mutation == 'object-links': story['links'] = {}
elif mutation == 'invalid-link': story['links'] = [None]
elif mutation == 'blank-file': story['links'][0]['file'] = ' '
elif mutation == 'invalid-line': story['links'][0]['line'] = True
elif mutation == 'invalid-confidence': story['links'][0]['confidence'] = 'unknown'
elif mutation == 'missing-method': del story['links'][0]['method']
elif mutation == 'invalid-id': story['id'] = ' '
elif mutation == 'duplicate-id': data['stories'].append(story.copy())
elif mutation == 'missing-status': del story['status']
path.write_text(json.dumps(data))
PY
  if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$INVALID_STORY/scripts/check-blind-spots.sh" > "$TMP/$mutation.out" 2>&1; then
    fail "blind-spot checker accepted $mutation story"
  fi
  assert_contains "$TMP/$mutation.out" 'check-blind-spots.py: ERROR'
  [[ ! -e "$INVALID_STORY/specs/blind-spots.json" ]] || fail "$mutation left stale blind-spot evidence"
done

COVERAGE_WARNING="$TMP/coverage-warning"
make_fixture "$COVERAGE_WARNING" '{score: 1}'
cat >> "$COVERAGE_WARNING/specs/epics/e01-fixture/epic.yaml" <<'YAML'
  - id: e01s06
    title: Second fixture story
    bcp: 1
    description: An untagged story for generated coverage.
YAML
printf 'development_status:\n  e01s05: active\n  e01s06: active\n' > "$COVERAGE_WARNING/specs/execution-status.yaml"
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$COVERAGE_WARNING/scripts/trace-stories.sh" --json > "$TMP/coverage-trace.out" 2>&1 \
  || { cat "$TMP/coverage-trace.out" >&2; fail "could not generate trace matrix for coverage fixture"; }
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$COVERAGE_WARNING/scripts/check-blind-spots.sh" > "$TMP/coverage-blind.out" 2>&1 \
  || { cat "$TMP/coverage-blind.out" >&2; fail "blind-spot check failed for generated coverage fixture"; }
if ! bash "$COVERAGE_WARNING/scripts/lib/completeness-critic.sh" > "$TMP/critic-warning.out" 2>&1; then
  cat "$TMP/critic-warning.out" >&2
  fail "completeness critic rejected the generated warning-only fixture"
fi
assert_contains "$TMP/critic-warning.out" '[WARNING] Trace coverage 50.0% below 60% target'
assert_contains "$TMP/critic-warning.out" 'completeness-critic: BLOCKER=0 WARNING=1'

cp "$GOOD/specs/traceability-matrix.json" "$TMP/valid-matrix.json"
printf '{malformed\n' > "$GOOD/specs/traceability-matrix.json"
if bash "$GOOD/scripts/lib/completeness-critic.sh" > "$TMP/critic-bad-matrix.out" 2>&1; then
  fail "completeness critic accepted malformed trace JSON"
fi
assert_contains "$TMP/critic-bad-matrix.out" 'Malformed specs/traceability-matrix.json'
mv "$TMP/valid-matrix.json" "$GOOD/specs/traceability-matrix.json"

cp "$GOOD/specs/blind-spots.json" "$TMP/valid-blind-spots.json"
printf '{malformed\n' > "$GOOD/specs/blind-spots.json"
if bash "$GOOD/scripts/lib/completeness-critic.sh" > "$TMP/critic-bad-blind.out" 2>&1; then
  fail "completeness critic accepted malformed blind-spot JSON"
fi
assert_contains "$TMP/critic-bad-blind.out" 'Malformed specs/blind-spots.json'
mv "$TMP/valid-blind-spots.json" "$GOOD/specs/blind-spots.json"

for invalid_finding in '{"severity":"CRITICAL","check":"fixture"}' 'null' '{"check":"fixture"}' '{"severity":"LOW"}'; do
  printf '{"findings":[%s]}\n' "$invalid_finding" > "$GOOD/specs/blind-spots.json"
  if bash "$GOOD/scripts/lib/completeness-critic.sh" > "$TMP/critic-bad-finding.out" 2>&1; then
    fail "completeness critic accepted malformed finding record: $invalid_finding"
  fi
  assert_contains "$TMP/critic-bad-finding.out" 'Malformed specs/blind-spots.json — findings must include check, severity HIGH/MEDIUM/LOW, description, remediation, and story_id or file'
  assert_contains "$TMP/critic-bad-finding.out" 'BLOCKER=1'
done
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$GOOD/scripts/check-blind-spots.sh" > /dev/null 2>&1 || fail "could not restore valid blind-spot report after malformed-finding cases"

mkdir -p "$TMP/no-jq-bin"
ln -s "$(command -v dirname)" "$TMP/no-jq-bin/dirname"
if PATH="$TMP/no-jq-bin" /bin/bash "$GOOD/scripts/lib/completeness-critic.sh" > "$TMP/no-jq.out" 2>&1; then
  fail "completeness critic accepted missing jq"
fi
assert_contains "$TMP/no-jq.out" 'required tool not found: jq'

# Missing or malformed inputs must fail and must not yield a success-shaped
# trace matrix. Each case uses a fresh disposable copy.
MISSING="$TMP/missing"
make_fixture "$MISSING" '{score: 1}'
printf '{"stories":[{"id":"stale"}]}\n' > "$MISSING/specs/traceability-matrix.json"
rm "$MISSING/specs/release-plan.yaml"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$MISSING/scripts/trace-stories.sh" --json > "$TMP/missing.out" 2>&1; then
  fail "trace generator accepted a missing release plan"
fi
assert_contains "$TMP/missing.out" 'required input not found'
[[ ! -e "$MISSING/specs/traceability-matrix.json" ]] || fail "missing input left a matrix artifact"

MALFORMED="$TMP/malformed"
make_fixture "$MALFORMED" '{score: 1}' '{score: 1}'
printf 'epics: [\n' > "$MALFORMED/specs/release-plan.yaml"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$MALFORMED/scripts/trace-stories.sh" --json > "$TMP/malformed.out" 2>&1; then
  fail "trace generator accepted malformed YAML"
fi
[[ ! -e "$MALFORMED/specs/traceability-matrix.json" ]] || fail "malformed input left a matrix artifact"

BAD_SCORE="$TMP/bad-score"
make_fixture "$BAD_SCORE" '{score: nope}'
printf '{"stories":[{"id":"stale"}]}\n' > "$BAD_SCORE/specs/traceability-matrix.json"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$BAD_SCORE/scripts/trace-stories.sh" --json > "$TMP/bad-score.out" 2>&1; then
  fail "trace generator accepted a nonnumeric wsjf.score"
fi
assert_contains "$TMP/bad-score.out" 'invalid WSJF score'
[[ ! -e "$BAD_SCORE/specs/traceability-matrix.json" ]] || fail "invalid score left a matrix artifact"

MISSING_SCORE="$TMP/missing-score"
make_fixture "$MISSING_SCORE" '{business_value: 1}'
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$MISSING_SCORE/scripts/trace-stories.sh" --json > "$TMP/missing-score.out" 2>&1; then
  fail "trace generator accepted a WSJF mapping without score"
fi
assert_contains "$TMP/missing-score.out" 'wsjf mapping has no score'
[[ ! -e "$MISSING_SCORE/specs/traceability-matrix.json" ]] || fail "missing score left a matrix artifact"

EMPTY_INVENTORY="$TMP/empty-inventory"
make_fixture "$EMPTY_INVENTORY" '{score: 1}'
printf 'epics: []\n' > "$EMPTY_INVENTORY/specs/release-plan.yaml"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$EMPTY_INVENTORY/scripts/trace-stories.sh" --json > "$TMP/empty-inventory.out" 2>&1; then
  fail "trace generator accepted an empty epic inventory"
fi
assert_contains "$TMP/empty-inventory.out" 'epics must be a non-empty list'
[[ ! -e "$EMPTY_INVENTORY/specs/traceability-matrix.json" ]] || fail "empty inventory left a matrix artifact"

MISSING_CAPSULE="$TMP/missing-capsule"
make_fixture "$MISSING_CAPSULE" '{score: 1}'
sed 's|capsule_dir: epics/e01-fixture|capsule_dir: epics/not-present|' "$MISSING_CAPSULE/specs/release-plan.yaml" > "$TMP/missing-capsule-plan.yaml"
mv "$TMP/missing-capsule-plan.yaml" "$MISSING_CAPSULE/specs/release-plan.yaml"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$MISSING_CAPSULE/scripts/trace-stories.sh" --json > "$TMP/missing-capsule.out" 2>&1; then
  fail "trace generator accepted a missing epic capsule"
fi
assert_contains "$TMP/missing-capsule.out" 'capsule directory not found'
[[ ! -e "$MISSING_CAPSULE/specs/traceability-matrix.json" ]] || fail "missing capsule left a matrix artifact"

OUT_OF_ROOT="$TMP/out-of-root"
make_fixture "$OUT_OF_ROOT" '{score: 1}'
sed "s|capsule_dir: epics/e01-fixture|capsule_dir: $TMP/outside-capsule|" "$OUT_OF_ROOT/specs/release-plan.yaml" > "$TMP/out-of-root-plan.yaml"
mv "$TMP/out-of-root-plan.yaml" "$OUT_OF_ROOT/specs/release-plan.yaml"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$OUT_OF_ROOT/scripts/trace-stories.sh" --json > "$TMP/out-of-root.out" 2>&1; then
  fail "trace generator accepted an out-of-root capsule path"
fi
assert_contains "$TMP/out-of-root.out" 'path must be relative to specs/'
[[ ! -e "$OUT_OF_ROOT/specs/traceability-matrix.json" ]] || fail "out-of-root capsule left a matrix artifact"

SYMLINK_SPECS="$TMP/symlink-specs"
make_fixture "$SYMLINK_SPECS" '{score: 1}'
mv "$SYMLINK_SPECS/specs" "$TMP/external-specs"
printf '{"stories":[{"id":"sentinel"}]}\n' > "$TMP/external-specs/traceability-matrix.json"
ln -s "$TMP/external-specs" "$SYMLINK_SPECS/specs"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$SYMLINK_SPECS/scripts/trace-stories.sh" --json > "$TMP/symlink-specs-trace.out" 2>&1; then
  fail "trace generator accepted a symlinked specs directory"
fi
assert_contains "$TMP/symlink-specs-trace.out" 'refusing symlinked specs directory'
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$SYMLINK_SPECS/scripts/check-blind-spots.sh" > "$TMP/symlink-specs-blind.out" 2>&1; then
  fail "blind-spot checker accepted a symlinked specs directory"
fi
assert_contains "$TMP/symlink-specs-blind.out" 'refusing symlinked specs directory'
assert_contains "$TMP/external-specs/traceability-matrix.json" 'sentinel'

SYMLINK_BLIND_OUTPUT="$TMP/symlink-blind-output"
make_fixture "$SYMLINK_BLIND_OUTPUT" '{score: 1}'
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$SYMLINK_BLIND_OUTPUT/scripts/trace-stories.sh" --json > /dev/null 2>&1 \
  || fail "could not generate matrix for symlinked blind-spot output fixture"
BLIND_SENTINEL="$TMP/blind-spot-sentinel.json"
printf '{"sentinel":"preserve"}\n' > "$BLIND_SENTINEL"
ln -s "$BLIND_SENTINEL" "$SYMLINK_BLIND_OUTPUT/specs/blind-spots.json"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$SYMLINK_BLIND_OUTPUT/scripts/check-blind-spots.sh" > "$TMP/symlink-blind-output.out" 2>&1; then
  fail "blind-spot checker accepted a symlinked report output path"
fi
assert_contains "$TMP/symlink-blind-output.out" 'refusing symlinked blind-spot output path'
[[ -L "$SYMLINK_BLIND_OUTPUT/specs/blind-spots.json" ]] || fail "blind-spot checker removed the symlinked report path"
assert_contains "$BLIND_SENTINEL" 'preserve'

SYMLINK_WIKI="$TMP/symlink-wiki"
make_fixture "$SYMLINK_WIKI" '{score: 1}'
mkdir -p "$TMP/external-wiki"
ln -s "$TMP/external-wiki" "$SYMLINK_WIKI/specs/codebase-wiki"
printf '{"stories":[{"id":"stale"}]}\n' > "$SYMLINK_WIKI/specs/traceability-matrix.json"
printf 'stale report\n' > "$SYMLINK_WIKI/specs/TRACEABILITY_LATEST.md"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$SYMLINK_WIKI/scripts/trace-stories.sh" --json > "$TMP/symlink-wiki.out" 2>&1; then
  fail "trace generator accepted a symlinked wiki output directory"
fi
assert_contains "$TMP/symlink-wiki.out" 'refusing symlinked codebase-wiki output directory'
assert_contains "$SYMLINK_WIKI/specs/traceability-matrix.json" 'stale'
assert_contains "$SYMLINK_WIKI/specs/TRACEABILITY_LATEST.md" 'stale report'
[[ -z "$(ls -A "$TMP/external-wiki")" ]] || fail "trace generator wrote outside specs through wiki symlink"

SYMLINK_WIKI_FILE="$TMP/symlink-wiki-file"
make_fixture "$SYMLINK_WIKI_FILE" '{score: 1}'
mkdir -p "$SYMLINK_WIKI_FILE/specs/codebase-wiki"
printf 'sentinel\n' > "$TMP/external-wiki-file.md"
ln -s "$TMP/external-wiki-file.md" "$SYMLINK_WIKI_FILE/specs/codebase-wiki/e01s05.md"
printf '{"stories":[{"id":"stale"}]}\n' > "$SYMLINK_WIKI_FILE/specs/traceability-matrix.json"
printf 'stale report\n' > "$SYMLINK_WIKI_FILE/specs/TRACEABILITY_LATEST.md"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$SYMLINK_WIKI_FILE/scripts/trace-stories.sh" --json > "$TMP/symlink-wiki-file.out" 2>&1; then
  fail "trace generator accepted a symlinked generated story file"
fi
assert_contains "$TMP/symlink-wiki-file.out" 'refusing symlinked generated output'
assert_contains "$TMP/external-wiki-file.md" 'sentinel'
assert_contains "$SYMLINK_WIKI_FILE/specs/traceability-matrix.json" 'stale'
assert_contains "$SYMLINK_WIKI_FILE/specs/TRACEABILITY_LATEST.md" 'stale report'

BAD_STORY_ID="$TMP/bad-story-id"
make_fixture "$BAD_STORY_ID" '{score: 1}'
sed 's|id: e01s05|id: ../escape|' "$BAD_STORY_ID/specs/epics/e01-fixture/epic.yaml" > "$TMP/bad-story-id-epic.yaml"
mv "$TMP/bad-story-id-epic.yaml" "$BAD_STORY_ID/specs/epics/e01-fixture/epic.yaml"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$BAD_STORY_ID/scripts/trace-stories.sh" --json > "$TMP/bad-story-id.out" 2>&1; then
  fail "trace generator accepted a path-shaped story ID"
fi
assert_contains "$TMP/bad-story-id.out" 'invalid story id'
[[ ! -e "$BAD_STORY_ID/specs/traceability-matrix.json" ]] || fail "bad story ID left a matrix artifact"

MISSING_STATUS="$TMP/missing-status"
make_fixture "$MISSING_STATUS" '{score: 1}'
printf 'other_status: {}\n' > "$MISSING_STATUS/specs/execution-status.yaml"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$MISSING_STATUS/scripts/trace-stories.sh" --json > "$TMP/missing-status.out" 2>&1; then
  fail "trace generator accepted a missing development_status mapping"
fi
assert_contains "$TMP/missing-status.out" 'must contain a development_status mapping'
[[ ! -e "$MISSING_STATUS/specs/traceability-matrix.json" ]] || fail "missing status map left a matrix artifact"

MISSING_STORY_STATUS="$TMP/missing-story-status"
make_fixture "$MISSING_STORY_STATUS" '{score: 1}'
printf 'development_status: {}\n' > "$MISSING_STORY_STATUS/specs/execution-status.yaml"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$MISSING_STORY_STATUS/scripts/trace-stories.sh" --json > "$TMP/missing-story-status.out" 2>&1; then
  fail "trace generator accepted a missing story status"
fi
assert_contains "$TMP/missing-story-status.out" 'missing a nonempty status for e01s05'
[[ ! -e "$MISSING_STORY_STATUS/specs/traceability-matrix.json" ]] || fail "missing story status left a matrix artifact"

assert_blind_status_rejected malformed-status 'development_status: [' 'cannot parse execution status'
assert_blind_status_rejected wrong-status-shape 'development_status: []' 'must contain a development_status mapping'
assert_blind_status_rejected missing-blind-status 'development_status: {}' 'missing a nonempty status for e01s05'

EMPTY_BLIND_INVENTORY="$TMP/empty-blind-inventory"
make_fixture "$EMPTY_BLIND_INVENTORY" '{score: 1}'
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$EMPTY_BLIND_INVENTORY/scripts/trace-stories.sh" --json > /dev/null 2>&1 \
  || fail "could not generate matrix for empty blind-spot inventory case"
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$EMPTY_BLIND_INVENTORY/scripts/check-blind-spots.sh" > /dev/null 2>&1 \
  || fail "could not seed blind-spot output for empty inventory case"
[[ -f "$EMPTY_BLIND_INVENTORY/specs/blind-spots.json" ]] || fail "empty-inventory case did not seed stale blind-spot evidence"
printf '{"stories":[],"summary":{}}\n' > "$EMPTY_BLIND_INVENTORY/specs/traceability-matrix.json"
printf 'development_status: {}\n' > "$EMPTY_BLIND_INVENTORY/specs/execution-status.yaml"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$EMPTY_BLIND_INVENTORY/scripts/check-blind-spots.sh" > "$TMP/empty-blind-inventory.out" 2>&1; then
  fail "blind-spot checker accepted an empty story inventory"
fi
assert_contains "$TMP/empty-blind-inventory.out" 'must contain a non-empty stories list'
[[ ! -e "$EMPTY_BLIND_INVENTORY/specs/blind-spots.json" ]] || fail "empty inventory left stale blind-spot evidence"

VISIBLE_FINDINGS="$TMP/visible-findings"
make_fixture "$VISIBLE_FINDINGS" '{score: 1}'
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$VISIBLE_FINDINGS/scripts/trace-stories.sh" --json > /dev/null 2>&1 \
  || fail "could not generate matrix for visible blind-spot findings case"
"$PYTHON" - "$VISIBLE_FINDINGS/specs/traceability-matrix.json" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
data["stories"] = [
    {"id": "e01s05", "status": "active", "links": [{"file": "specs/epics/e01-fixture/e01s05-tasks.yaml", "line": 0, "confidence": "low", "method": "task_reference"}]},
    {"id": "e01s06", "status": "active", "links": [{"file": "specs/epics/e01-fixture/e01s05-tasks.yaml", "line": 0, "confidence": "low", "method": "task_reference"}]},
]
data["summary"]["stale_tags"] = ["e01s06"]
path.write_text(json.dumps(data), encoding="utf-8")
PY
printf 'development_status:\n  e01s05: active\n  e01s06: active\n' > "$VISIBLE_FINDINGS/specs/execution-status.yaml"
if ! PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$VISIBLE_FINDINGS/scripts/check-blind-spots.sh" > "$TMP/visible-findings.out" 2>&1; then
  cat "$TMP/visible-findings.out" >&2
  fail "nonblocking MEDIUM/LOW blind-spot findings failed the gate"
fi
assert_contains "$TMP/visible-findings.out" '[MEDIUM] double-tag:'
assert_contains "$TMP/visible-findings.out" '[LOW] stale-tag:'
assert_contains "$TMP/visible-findings.out" '0 HIGH, 1 MEDIUM, 1 LOW'

# A partial grep result is not sufficient evidence for a traceability matrix.
PARTIAL_GREP="$TMP/partial-grep"
make_fixture "$PARTIAL_GREP" '{score: 1}'
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$PARTIAL_GREP/scripts/trace-stories.sh" --json > /dev/null 2>&1 \
  || fail "could not seed trace outputs for partial-grep case"
mkdir -p "$TMP/partial-grep-bin"
cat > "$TMP/partial-grep-bin/grep" <<'SH'
#!/bin/sh
printf '%s\n' "$FIXTURE_ROOT/src/partial.ts:1:// story: e01s05"
echo 'grep: one fixture file could not be read' >&2
exit 2
SH
chmod +x "$TMP/partial-grep-bin/grep"
if FIXTURE_ROOT="$PARTIAL_GREP" PATH="$TMP/partial-grep-bin:$PATH" PI_SESSION_MEMORY_PYTHON="$PYTHON" \
  bash "$PARTIAL_GREP/scripts/trace-stories.sh" --json > "$TMP/partial-grep.out" 2>&1; then
  fail "trace generator accepted a partial grep result"
fi
assert_contains "$TMP/partial-grep.out" 'grep failed with exit 2'
[[ ! -e "$PARTIAL_GREP/specs/traceability-matrix.json" ]] || fail "grep error left a stale trace matrix"
[[ ! -e "$PARTIAL_GREP/specs/TRACEABILITY_LATEST.md" ]] || fail "grep error left a stale trace report"

# The blind-spot adapter must not invoke its analyzer without the generated
# matrix; the critic must reject missing artifacts and open HIGH findings.
rm "$GOOD/specs/traceability-matrix.json"
if PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$GOOD/scripts/check-blind-spots.sh" > "$TMP/no-matrix.out" 2>&1; then
  fail "blind-spot check accepted a missing matrix"
fi
assert_contains "$TMP/no-matrix.out" 'required input not found'
[[ ! -e "$GOOD/specs/blind-spots.json" ]] || fail "missing matrix left stale blind-spot evidence"
PI_SESSION_MEMORY_PYTHON="$PYTHON" bash "$GOOD/scripts/trace-stories.sh" --json > /dev/null 2>&1 \
  || fail "could not regenerate fixture matrix"
rm -f "$GOOD/specs/blind-spots.json"
if bash "$GOOD/scripts/lib/completeness-critic.sh" > "$TMP/no-blindspots.out" 2>&1; then
  fail "completeness critic accepted missing blind-spot evidence"
fi
assert_contains "$TMP/no-blindspots.out" 'BLOCKER=1'

printf '{"findings":[{"severity":"HIGH","check":"fixture","story_id":"e01s05","description":"fixture blocker","remediation":"close fixture blocker"}]}\n' > "$GOOD/specs/blind-spots.json"
if bash "$GOOD/scripts/lib/completeness-critic.sh" > "$TMP/high.out" 2>&1; then
  fail "completeness critic accepted an open HIGH finding"
fi
assert_contains "$TMP/high.out" 'HIGH-severity blind-spot finding(s) remain open'
assert_contains "$TMP/high.out" 'BLOCKER=1'

echo "PASS: repository-root, malformed/missing-input, and blocker scenarios"
