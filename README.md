# pi-session-memory

[![Pi package](https://img.shields.io/badge/%CF%80-Pi_package-f0b429?style=flat-square)](https://pi.dev/packages/@sovorn/pi-session-memory)
[![npm](https://img.shields.io/npm/v/@sovorn/pi-session-memory?style=flat-square&logo=npm)](https://www.npmjs.com/package/@sovorn/pi-session-memory)
[![GitHub](https://img.shields.io/badge/GitHub-sovorn--c%2Fpi--session--memory-181717?style=flat-square&logo=github)](https://github.com/sovorn-c/pi-session-memory)

Session memory for [Pi](https://github.com/earendil-works/pi). It keeps short notes in your current coding session, linked to the original evidence. Local Laya decisions select which notes to keep and recall. Your Pi model writes notes only after you allow it.

Generation is off by default. If memory fails, Pi continues with its normal context. This is experimental, with no demonstrated benefit yet and no cross-session memory.

## Install

Choose one source. Pi loads the extension directly, with no build step.

### npm

```sh
pi install npm:@sovorn/pi-session-memory
```

Pi handles the npm download and extension registration. `npm install` alone does not register it in Pi.

### GitHub

```sh
pi install git:github.com/sovorn-c/pi-session-memory
```

### Local checkout

```sh
git clone https://github.com/sovorn-c/pi-session-memory.git
pi install /path/to/pi-session-memory
```

Replace the path with the cloned directory. Pi records it in settings without copying the directory.

Start Pi and run `/memory status` to check that the extension loaded. This does not start Laya or send a provider request.

## Requirements

You need Pi, Python 3.11, and a separate Laya installation with its model weights. Installation through Pi does not install Python or Laya. The tested platform is macOS on Apple Silicon, with Pi 1.0.2 and English session text.

## Laya setup

Complete the [Laya setup guide](docs/SETUP.md) before enabling generation. It covers the required Laya version, model files, and Python environment.

Point `PI_SESSION_MEMORY_PYTHON` at that environment's Python interpreter. Use `PI_SESSION_MEMORY_LAYA_CHECKPOINT` if your model files are outside the default Hugging Face cache. A setup mismatch leaves Pi running without memory.

## Use

| Command | Behavior |
| --- | --- |
| `/memory` or `/memory status` | Show generation, config path, Python command, and token cadence. |
| `/memory on` | Enable generation for this session. Pi asks for confirmation before the first write. |
| `/memory off` | Disable generation and revoke the session's stored confirmation. |

`/memory on` is not consent. A new session, fork, resume, or `/reload` clears the session switch and confirmation.

Notes remain in Pi's session history. Later requests may receive a small selection of notes. The model can use `hydrate_session_memory` to retrieve their supporting notes or exact linked entries. Pi's history and compaction remain intact.

## Configure

Configuration is optional. Create `~/.pi/agent/pi-session-memory/config.json` if you want to change the defaults. If you set `PI_CODING_AGENT_DIR`, use that directory instead of `~/.pi/agent`.

```json
{
  "generation": false,
  "python": "python3.11",
  "observeAfterTokens": 10000,
  "reflectAfterTokens": 20000
}
```

`generation` controls the initial switch, but enabling it still requires interactive confirmation. The cadence values must be positive integers. `PI_SESSION_MEMORY_PYTHON` takes priority over `python`. Edit the file, then `/reload` or start Pi again.

The extension never writes this file. A missing file uses defaults. A malformed file uses defaults and warns once.

## What gets sent

Laya runs locally. When generation is enabled, Pi asks before sending session-derived text and source IDs to your configured model/provider to write notes:

> Session-derived text and its source entry IDs will be sent to the currently configured Pi model/provider only after a local Laya gate accepts. Laya runs locally. The Pi session remains canonical; generated memories are appended as non-context session entries. Do you allow this for the current session?

Declining prevents that write. Session text may include private content; the extension does not automatically redact it.

Projected memory reaches the normal Pi provider in a request Pi was already sending. Hydration returns linked entries from the current session without a separate provider call. Turning generation off does not disable recall of existing notes.

## Disable and remove

`/memory off` stops generation for the current session. Use `pi --no-extensions` to disable all extensions for a run, including memory generation and recall.

Remove the source you installed:

```sh
pi remove npm:@sovorn/pi-session-memory
# Or, for a GitHub install:
pi remove git:github.com/sovorn-c/pi-session-memory
# Or, for a local checkout:
pi remove /path/to/pi-session-memory
```

Removal drops the package source from Pi's settings. It does not delete session files or the Laya cache.

## Known limitations

- Experimental, English-only, and tested on macOS arm64 within one Pi session. There is no cross-session memory.
- Provider-backed memory formation is not verified on Pi 1.0.2. Its current compatibility checks used generation off, in no-provider runs.
- Laya setup is machine-specific. The first load can take seconds, and some decisions have uncalibrated confidence.
- In RPC mode, confirmation waits for the client's answer.
- A local source security review found no blocking findings. This is not a guarantee of security.
- No license has been selected; publication alone does not grant permission to reuse the code.

See [developer notes](docs/DEVELOPMENT.md) for verification scripts, runtime limits, and the recorded trial.

Report problems in [GitHub issues](https://github.com/sovorn-c/pi-session-memory/issues). Include Pi and Python versions and `/memory status` output. Do not post session text, credentials, or private paths.
