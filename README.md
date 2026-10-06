# pi-session-memory

Local experimental Pi extension for one session. It keeps source-linked observations and reflections in the Pi session, asks upstream Laya for bounded gates and selection, and can insert a small working set into the request Pi already sends. Pi stays usable when the extension fails.

This repository is not published. The pre-publication security review has not been run.

## Prerequisites

Checked on one macOS Apple Silicon (arm64) machine, English, one Pi session:

- Pi `1.0.2`
- Node `v26.7.0`
- Python `3.11.15` via `PI_SESSION_MEMORY_PYTHON`
- Upstream Laya `0.3.7` at commit `010bacef009c855ccba814b51f7c8e1d38ab5e3f`
- Checkpoint revision `f9ab0b228f0fc0f14d873dbc99038f135c2da1b2`
- `model.safetensors` SHA-256 `4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e`

The default checkpoint directory is machine-specific:

`~/.cache/pi-session-memory/bp-init-laya-010bacef/hf/hub/models--convaiinnovations--laya-typed-decisions/snapshots/f9ab0b228f0fc0f14d873dbc99038f135c2da1b2`

`PI_SESSION_MEMORY_LAYA_CHECKPOINT` overrides that directory. Its final path component must equal the revision above.

Offline cache variables used with the commands below: `HF_HOME`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`.

## Setup

From this repository, with the cache already present:

```sh
export PATH="/opt/homebrew/bin:$PATH"
export PI_SESSION_MEMORY_PYTHON="$HOME/.cache/pi-session-memory/bp-init-laya-010bacef/bin/python"
export PYTHONDONTWRITEBYTECODE=1
export PI_OFFLINE=1
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0
export HF_HOME="$HOME/.cache/pi-session-memory/bp-init-laya-010bacef/hf"
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export USE_TF=0
export TOKENIZERS_PARALLELISM=false
test -x "$PI_SESSION_MEMORY_PYTHON"
test -r "$HF_HOME/hub/models--convaiinnovations--laya-typed-decisions/snapshots/f9ab0b228f0fc0f14d873dbc99038f135c2da1b2/model.safetensors"
shasum -a 256 "$HF_HOME/hub/models--convaiinnovations--laya-typed-decisions/snapshots/f9ab0b228f0fc0f14d873dbc99038f135c2da1b2/model.safetensors"
```

Compare the digest to the hash above. No checkpoint download command is recorded: the cached snapshot has no `refs` directory. The cache must already contain that snapshot.

## Load

The `e01-*` prefix is historical. Two routes:

```sh
pi --extension "$PWD/src/extension.ts" --help
```

Persistent use writes an absolute path into `<agent>/settings.json` (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`):

```json
{ "extensions": ["/absolute/path/to/pi-session-memory/src/extension.ts"] }
```

Loaded Pi lists `--e01-memory-generation` (boolean, default false), `--e01-observe-after-tokens` (default `10000`), `--e01-reflect-after-tokens` (default `20000`), `--e01-memory-candidates` (default `6`, max 8), and `--e01-memory-projection-chars` (default `4000`, max 6000).

Loading registers those flags. It does not start the Laya worker and it does not call a model provider. The worker starts at the first Laya gate. See [src/extension.ts](src/extension.ts).

## Use

With generation left off, Pi keeps working. Stored memory stays in custom entries. Pi does not copy that text into model-visible messages.

When the current user text needs earlier memory, local Laya may select one candidate. That text is inserted into the request Pi was already going to send. See [src/projection.ts](src/projection.ts).

The model can call `hydrate_session_memory` for a reflection, its observation, or the exact linked raw entries. Missing links are reported and not invented. See [src/hydration.ts](src/hydration.ts).

## Disable

`pi --no-extensions` turns the extension off for that run even when `settings.json` lists it. Session files stay.

## Remove

Delete the extension path from `settings.json`. Leave session files, this clone, the Python environment, and the checkpoint cache in place. A following `pi --help` lists no `--e01-*` flags.

```sh
pi --help
```

## Provisioning (recorded, not re-run by this project)

These two commands are how the local environment was created. They are not re-run by this project, and they are not a from-scratch installer:

```sh
uv venv --python python3.11 '<env>'
uv pip install --python '<env>/bin/python' '<local Laya checkout at 010bacef009c855ccba814b51f7c8e1d38ab5e3f>'
```

The checkout is upstream Laya at that commit: https://github.com/NandhaKishorM/laya

Point `PI_SESSION_MEMORY_PYTHON` at `'<env>/bin/python'`. Check the snapshot with the `shasum` command in Setup. Do not invent a download.

## Data flow and provider opt-in

The Pi session stays canonical and local. The extension appends non-context custom entries only when generation is enabled. Laya runs locally in a Python subprocess over JSONL and only gates or selects. It does not write memory text.

Generation is off by default (`--e01-memory-generation` defaults to false). With generation off, this extension does not send session text to a provider.

With `--e01-memory-generation` set, an interactive confirmation is required. The confirmation shows this disclosure before any session-derived text is sent:

Session-derived text and its source entry IDs will be sent to the currently configured Pi model/provider only after a local Laya gate accepts. Laya runs locally. The Pi session remains canonical; generated memories are appended as non-context session entries. Do you allow this for the current session?

After you confirm, and only after the local Laya gate accepts, session-derived text and source entry IDs go to the currently configured Pi model. The extension has one provider call site, `modelRegistry.complete`.

Selected memory text is inserted into the request Pi already sends to its configured model, so projected memory reaches the normal Pi provider.

`hydrate_session_memory` returns session evidence to the model on demand.

An extension runs inside the Pi process with Pi's operating-system permissions. Read [src/extension.ts](src/extension.ts), [src/projection.ts](src/projection.ts), [src/hydration.ts](src/hydration.ts), and [worker/laya_runtime.py](worker/laya_runtime.py) before loading it.

A static scan of this extension's `src/` and `worker/` finds no telemetry client and no other network client. That is only about this extension. Pi and upstream libraries have their own behavior. Use `PI_TELEMETRY=0`, `PI_OFFLINE=1`, `HF_HUB_OFFLINE=1`, and `TRANSFORMERS_OFFLINE=1` for those switches.

## Observed usefulness

The recorded E03 outcome is `no-demonstrated-benefit`. There is no demonstrated benefit. The trial was one synthetic-session pair, model `openai-codex/gpt-6-luna`, thinking low, Pi 1.0.2, 8 provider calls, 3 Laya decisions. Both arms scored correct by a keyword oracle. The native arm ran first. Token usage was not recorded.

## Known limitations

- macOS arm64, English, one Pi session; no cross-session memory.
- Pi 1.0.2 provider-backed memory formation is not verified. Formation was last verified on Pi 0.87.1. On 1.0.2 the recorded compaction and resume ran with generation off, and the no-provider suites ran. A provider-backed formation run on 1.0.2 needs fresh consent and is not scheduled.
- Flag names still use the historical `e01-*` prefix.
- The checkpoint path and the Laya source checkout are pinned and machine-specific.
- Laya confidence is uncalibrated for some choices.
- The first Laya load can take seconds.
- No build, lint, typecheck, or CI is configured.
- This is not a Pi package and has no `pi install` flow.
- Not published. The single pre-publication security review has not been run.

## Status

Publication is pending an explicit owner instruction. The security review is pending. Neither has been run.

## Walkthrough

Run from the repository root. Copy a session jsonl that already contains observation, reflection, and supersession entries, and export that copy as `SESSION_COPY`. The block opens a further copy under a throwaway agent directory.

<!-- e04-walkthrough:start -->
```sh
set -euo pipefail
repo="${PWD}"
case "${SESSION_COPY}" in
  /*) ;;
  *) SESSION_COPY="${repo}/${SESSION_COPY}" ;;
esac
export PATH="/opt/homebrew/bin:${PATH}"
export PI_SESSION_MEMORY_PYTHON="${PI_SESSION_MEMORY_PYTHON:-${HOME}/.cache/pi-session-memory/bp-init-laya-010bacef/bin/python}"
export PYTHONDONTWRITEBYTECODE=1
export PI_OFFLINE=1
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0
export HF_HOME="${HF_HOME:-${HOME}/.cache/pi-session-memory/bp-init-laya-010bacef/hf}"
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export USE_TF=0
export TOKENIZERS_PARALLELISM=false
test -f "${repo}/src/extension.ts"
test -f "${repo}/test/pi/projection.test.ts"
test -n "${SESSION_COPY}"
test -f "${SESSION_COPY}"
pi_version="$(pi --version)"
test "${pi_version}" = "1.0.2"
node_version="$(node --version)"
test "${node_version}" = "v26.7.0"
test -x "${PI_SESSION_MEMORY_PYTHON}"
py_version="$("${PI_SESSION_MEMORY_PYTHON}" --version 2>&1)"
test "${py_version}" = "Python 3.11.15"
revision="f9ab0b228f0fc0f14d873dbc99038f135c2da1b2"
weights="${HF_HOME}/hub/models--convaiinnovations--laya-typed-decisions/snapshots/${revision}/model.safetensors"
test -r "${weights}"
expected_sha="4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e"
actual_sha="$(shasum -a 256 "${weights}" | awk '{print $1}')"
test "${actual_sha}" = "${expected_sha}"
agent="$(mktemp -d)"
work="$(mktemp -d)"
pi_home="$(mktemp -d)"
cleanup() {
  if [ -n "${agent:-}" ]; then rm -rf "${agent}"; fi
  if [ -n "${work:-}" ]; then rm -rf "${work}"; fi
  if [ -n "${pi_home:-}" ]; then rm -rf "${pi_home}"; fi
}
trap cleanup EXIT
export PI_CODING_AGENT_DIR="${agent}"
extension="${repo}/src/extension.ts"
cd "${pi_home}"
pi --extension "${extension}" --help | grep -F -- "--e01-memory-generation"
echo LOADED
printf '%s\n' "{\"extensions\":[\"${extension}\"]}" > "${agent}/settings.json"
pi --help | grep -F -- "--e01-memory-candidates"
disabled="$(pi --no-extensions --help)"
case "${disabled}" in
  *--e01-*)
    echo "memory flags still listed with --no-extensions" >&2
    exit 1
    ;;
esac
echo DISABLED
printf '%s\n' "{}" > "${agent}/settings.json"
removed="$(pi --help)"
case "${removed}" in
  *--e01-*)
    echo "memory flags still listed after settings.json removal" >&2
    exit 1
    ;;
esac
echo REMOVED
test -f "${extension}"
test -x "${PI_SESSION_MEMORY_PYTHON}"
test -r "${weights}"
copy_hash="$(shasum -a 256 "${SESSION_COPY}" | awk '{print $1}')"
cp "${SESSION_COPY}" "${work}/session.jsonl"
rpc="$(pi --mode rpc --no-extensions --session-dir "${work}" --session "${work}/session.jsonl" --no-context-files --no-skills --no-tools <<EOF
{"type":"get_entries","id":"entries"}
{"type":"get_messages","id":"messages"}
EOF
)"
printf '%s\n' "${rpc}" | grep -F -- "pi-session-memory.observation"
printf '%s\n' "${rpc}" | grep -F -- "pi-session-memory.reflection"
printf '%s\n' "${rpc}" | grep -F -- "pi-session-memory.supersession"
"${PI_SESSION_MEMORY_PYTHON}" - "${SESSION_COPY}" "${work}/session.jsonl" <<'PY'
import pathlib, sys
original = pathlib.Path(sys.argv[1]).read_bytes()
opened = pathlib.Path(sys.argv[2]).read_bytes()
if not opened.startswith(original):
    raise SystemExit("opened session dropped or rewrote the original prefix")
print("PREFIX_OK")
PY
after_hash="$(shasum -a 256 "${SESSION_COPY}" | awk '{print $1}')"
test "${after_hash}" = "${copy_hash}"
echo SESSION_COPY_UNCHANGED
cd "${repo}"
unset NODE_TEST_CONTEXT
node --test --test-reporter tap test/pi/projection.test.ts
echo PROJECTION_OK
```
<!-- e04-walkthrough:end -->
