# Developer notes

These checks are for contributors working from a source checkout. Users only need to start Pi and run `/memory status` to check that the extension loaded.

## Package and runtime

The Pi package entry is `./src/extension.ts`. Pi loads it without a build step. No build, lint, typecheck, or CI is configured.

Candidate count and projected note length are internal limits, not user settings. The candidate count is 6, maximum 8. The projection limit is 4000 characters, maximum 6000.

## Data flow checks

There is one provider call site, `modelRegistry.complete`. Generation is off by default and needs interactive confirmation after a local Laya gate accepts. `/memory on` is not consent.

Projected memory reaches the normal Pi provider in an existing request. `hydrate_session_memory` resolves linked evidence from the active branch without a separate provider call.

The extension runs with Pi's permissions. Behavior lives under `src/` and `worker/`. A static scan finds no telemetry client and no network client in those directories. This does not audit Pi or Laya dependencies.

Recorded offline checks set `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `HF_HUB_OFFLINE=1`, and `TRANSFORMERS_OFFLINE=1`. Do not run provider-backed tests without explicit consent.

## Verify installation

Run this block from the repository root. It uses a temporary Pi agent directory, checks command registration and disable behavior, then removes the package. It needs no Laya cache and sends no provider request.

<!-- verify-install:start -->
```sh
set -euo pipefail
agent="$(mktemp -d)"
trap 'rm -rf "$agent"' EXIT
export PI_CODING_AGENT_DIR="$agent"
export PI_OFFLINE=1
pi --version
node --version
pi install "$PWD"
loaded="$(printf '%s\n' '{"type":"get_commands","id":"commands"}' | pi --mode rpc --no-session)"
printf '%s\n' "$loaded" | grep -F '"name":"memory"' >/dev/null
disabled="$(printf '%s\n' '{"type":"get_commands","id":"commands"}' | pi --mode rpc --no-session --no-extensions)"
if printf '%s\n' "$disabled" | grep -F '"name":"memory"' >/dev/null; then
  echo "memory listed while extensions are disabled" >&2
  exit 1
fi
pi remove "$PWD"
removed="$(printf '%s\n' '{"type":"get_commands","id":"commands"}' | pi --mode rpc --no-session)"
if printf '%s\n' "$removed" | grep -F '"name":"memory"' >/dev/null; then
  echo "memory still listed after remove" >&2
  exit 1
fi
```
<!-- verify-install:end -->

## Verify local Laya behavior

Run this block from the repository root with both environment variables set. The documentation test skips it when the runtime is absent. It runs worker and projection tests, not provider-backed formation.

<!-- verify-laya:start -->
```sh
set -euo pipefail
: "${PI_SESSION_MEMORY_PYTHON:?set PI_SESSION_MEMORY_PYTHON}"
: "${PI_SESSION_MEMORY_LAYA_CHECKPOINT:?set PI_SESSION_MEMORY_LAYA_CHECKPOINT}"
unset NODE_TEST_CONTEXT
"$PI_SESSION_MEMORY_PYTHON" -m unittest discover -s worker/tests -p 'test_*.py'
node --test test/pi/projection.test.ts
```
<!-- verify-laya:end -->

## Recorded trial and compatibility

One synthetic trial compared a native arm with a memory arm. The native arm ran first. The result was no demonstrated benefit. The keyword oracle did not show a gain. Token usage was not recorded.

The model was `openai-codex/gpt-6-luna` at thinking low, with 8 provider calls and 3 Laya decisions. This is historical evidence, not proof of usefulness.

Provider-backed memory formation is not verified on Pi 1.0.2. It was last verified on Pi 0.87.1. Pi 1.0.2 checks so far used generation off, in no-provider runs. Native lifecycle and provider compatibility require separate evidence.

In RPC mode, confirmation waits for the client's answer. The first Laya load can take seconds; some choices have uncalibrated confidence. Setup is machine-specific.
