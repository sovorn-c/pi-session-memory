# pi-session-memory

Session memory for [Pi](https://github.com/earendil-works/pi). It keeps a few short, source-linked notes for the coding session you have open. A local Laya model decides when a note is worth keeping and which note a later turn might need. Your configured Pi model writes the note only after you allow it for that session. If the extension or Laya fails, Pi keeps working with its normal context.

Generation is off by default. Install it, run `/memory status`, and nothing is generated.

## Install

Clone this repository, then install that directory. Pi records the path in `settings.json`. It does not copy the extension into Pi's directories, and there is no build step. The package entry is `./src/extension.ts`.

```sh
pi install /path/to/pi-session-memory
```

To load it for a single run instead:

```sh
pi -e /path/to/pi-session-memory/src/extension.ts
```

After install, start Pi and run `/memory`. You should see a status block: generation, config path, Python command, and token cadence.

## Requirements

You need Pi and Python 3.11. This tree was checked on macOS arm64 with Pi 1.0.2, Node v26.7.0, and Python 3.11.15.

Laya is 0.3.7 at commit `010bacef009c855ccba814b51f7c8e1d38ab5e3f`. The checkpoint revision is `f9ab0b228f0fc0f14d873dbc99038f135c2da1b2`. The `model.safetensors` SHA-256 is `4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e`.

## Configure

Optional. With no config file, generation stays off and the other defaults below apply.

The file is `<Pi agent dir>/pi-session-memory/config.json`. The agent directory is usually `~/.pi/agent`. `PI_CODING_AGENT_DIR` overrides it. You create the file yourself. The extension reads it when a session starts and never writes it. A missing file uses the defaults. A malformed file uses the defaults and warns once.

| Key | Type | Default |
| --- | --- | --- |
| `generation` | boolean | `false` |
| `python` | non-empty string, optional | `python3.11` |
| `observeAfterTokens` | integer >= 1 | `10000` |
| `reflectAfterTokens` | integer >= 1 | `20000` |

`PI_SESSION_MEMORY_PYTHON` overrides `python`. `PI_SESSION_MEMORY_LAYA_CHECKPOINT` overrides the checkpoint directory. For the Python command, the environment variable wins, then the config value, then `python3.11`.

How many notes can be considered (6, maximum 8) and how long a projected note can be (4000 characters, maximum 6000) are internal limits, not settings. Edit the file, then `/reload` or start Pi again.

Example, still off until you also confirm in the session:

```json
{
  "generation": false,
  "python": "python3.11",
  "observeAfterTokens": 10000,
  "reflectAfterTokens": 20000
}
```

## Use

`/memory` with no arguments is the same as `/memory status`.

`/memory status` prints whether generation is on, the config path, the Python command, and the cadence. It does not start Laya and does not call your model.

`/memory on` enables generation for this session only. `/memory on` is not consent. The first time this session is about to write a memory, Pi asks you to confirm. Nothing is sent until you confirm.

`/memory off` disables generation for this session and drops a confirmation already stored for it. Neither command writes the config file or the session file.

A new session, a fork, a resume, or `/reload` clears that session switch. You are asked again before the next write.

When a later request needs an earlier note, local Laya may select one. Projected memory reaches the normal Pi provider inside the request Pi was already going to send. The model can call `hydrate_session_memory` to read a reflection, the observation it came from, or the exact linked raw entries. A missing link is reported. A replacement is not invented.

## Disable and remove

`/memory off` turns generation off for the current session. The extension stays loaded.

`pi --no-extensions` disables every extension for that run, including this one if you installed it.

```sh
pi remove /path/to/pi-session-memory
```

Remove drops the package path from `settings.json`. Your session files and any Laya cache stay where they are.

## What gets sent

Generation is off by default. A write needs both a switch and an interactive confirmation: `generation: true` in the config, or `/memory on`, and then your answer for that session. `/memory on` is not consent. Pi shows this question:

> Session-derived text and its source entry IDs will be sent to the currently configured Pi model/provider only after a local Laya gate accepts. Laya runs locally. The Pi session remains canonical; generated memories are appended as non-context session entries. Do you allow this for the current session?

There is one provider call site, `modelRegistry.complete`. Decline, and that write does not happen. Projected memory reaches the normal Pi provider as part of a request Pi was already sending. `hydrate_session_memory` returns entries already in the session and does not call the provider.

The extension runs with Pi's permissions. Behavior lives under `src/` and `worker/`. A static scan of `src/` and `worker/` finds no telemetry client and no network client. Recorded checks set `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `HF_HUB_OFFLINE=1`, and `TRANSFORMERS_OFFLINE=1`.

## What one trial showed

One synthetic trial compared a native arm with a memory arm. The native arm ran first. The result was no demonstrated benefit. The keyword oracle did not show a gain. Token usage was not recorded. The model was `openai-codex/gpt-6-luna` at thinking low, with 8 provider calls and 3 Laya decisions.

## Known limitations

- Checked on macOS arm64, English, and one Pi session. There is no cross-session memory.
- Provider-backed memory formation is not verified on Pi 1.0.2. It was last verified on Pi 0.87.1. Pi 1.0.2 checks so far used generation off, in no-provider runs.
- In RPC mode the confirmation waits for the client's answer.
- The first Laya load can take seconds. Laya confidence is uncalibrated for some choices.
- No build, lint, typecheck, or CI is configured. Laya setup is machine-specific.
- This is experimental. The security review has not been run.

## Laya setup

Point `PI_SESSION_MEMORY_PYTHON` at a Python 3.11 interpreter that can import Laya. This VCS-form install is not run by this project:

```sh
uv pip install "laya @ git+https://github.com/NandhaKishorM/laya@010bacef009c855ccba814b51f7c8e1d38ab5e3f"
```

No download command is verified here. The checkpoint is the Hugging Face cache snapshot `models--convaiinnovations--laya-typed-decisions/snapshots/f9ab0b228f0fc0f14d873dbc99038f135c2da1b2`. The hub directory is `HF_HUB_CACHE`, otherwise `$HF_HOME/hub`, otherwise `$XDG_CACHE_HOME/huggingface/hub`, otherwise `~/.cache/huggingface/hub`. `PI_SESSION_MEMORY_LAYA_CHECKPOINT` overrides that directory. Check the weights with `shasum -a 256 model.safetensors` and compare it with the SHA-256 above. To refuse a hub fetch, set `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`.

## Check your install

The first block needs no Laya cache and sends no provider request. It installs the package into a temporary Pi agent directory, checks that `/memory` is listed, checks that `pi --no-extensions` hides it, then removes it. The second block needs the two environment variables. The doc test skips that block when they are absent.

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

## Status

Experimental. Not published. Publication is pending. The security review has not been run.
