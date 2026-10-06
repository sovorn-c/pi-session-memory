# Laya setup

This guide is for users who want to enable session-memory generation or recall. These dependencies are separate from the Pi package. Installing the extension alone does not install them.

## Python environment

Use Python 3.11 in an environment that can import Laya. Set `PI_SESSION_MEMORY_PYTHON` to that environment's interpreter, or set `python` in the extension's config file. The environment variable wins over config, then the default is `python3.11`.

The extension was checked on macOS arm64 with Pi 1.0.2, Node v26.7.0, and Python 3.11.15. Other platforms are not verified.

## Required Laya source

The worker accepts Laya 0.3.7 at commit `010bacef009c855ccba814b51f7c8e1d38ab5e3f`. It accepts the pinned local checkout or a VCS installation whose package metadata records that commit. An ordinary version-only installation is not enough.

For an existing Python 3.11 environment, this VCS-form install is not run by this project:

```sh
uv pip install --python "$PI_SESSION_MEMORY_PYTHON" "laya @ git+https://github.com/NandhaKishorM/laya@010bacef009c855ccba814b51f7c8e1d38ab5e3f"
```

The commit pins the tested Laya code. Pi and npm do not require it, but the current worker checks it. A mismatch disables memory instead of loading untested code.

## Model checkpoint

Use the Hugging Face `convaiinnovations/laya-typed-decisions` checkpoint at revision `f9ab0b228f0fc0f14d873dbc99038f135c2da1b2`. No download command is verified here.

The default cache snapshot is `models--convaiinnovations--laya-typed-decisions/snapshots/f9ab0b228f0fc0f14d873dbc99038f135c2da1b2`. The worker looks under these hub directories, in order:

1. `HF_HUB_CACHE`
2. `$HF_HOME/hub`
3. `$XDG_CACHE_HOME/huggingface/hub`
4. `~/.cache/huggingface/hub`

`PI_SESSION_MEMORY_LAYA_CHECKPOINT` overrides the snapshot directory. Its final directory name must match the required revision.

The `model.safetensors` SHA-256 must be `4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e`. Check it from the snapshot directory:

```sh
shasum -a 256 model.safetensors
```

The hash checks that the weights match the tested model file. Set `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` to refuse a hub fetch.

## Start using memory

Start Pi and run `/memory status`. This reports configuration, not whether Laya inference works. Once setup is complete, run `/memory on` and review the provider disclosure before confirming.

If the worker cannot load or trust a decision, Pi continues with native context and reports that memory is unavailable. Check your Python interpreter, Laya source, and checkpoint path first.
