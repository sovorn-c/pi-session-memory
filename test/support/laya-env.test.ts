import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { layaTestEnv } from "./laya-env.ts";

test("layaTestEnv names the first missing prerequisite and passes a ready runtime through", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "pi-session-memory-laya-env-"));
  try {
    const missingPython = layaTestEnv({});
    assert.equal(missingPython.ready, false);
    if (!missingPython.ready) {
      assert.match(missingPython.reason, /^Laya runtime unavailable: PI_SESSION_MEMORY_PYTHON/);
    }

    const python = resolve(root, "python");
    await writeFile(python, "#!/bin/sh\nexit 1\n");
    await chmod(python, 0o755);
    const missingCheckpoint = layaTestEnv({ PI_SESSION_MEMORY_PYTHON: python });
    assert.equal(missingCheckpoint.ready, false);
    if (!missingCheckpoint.ready) {
      assert.match(missingCheckpoint.reason, /^Laya runtime unavailable: PI_SESSION_MEMORY_LAYA_CHECKPOINT/);
    }

    const checkpoint = resolve(root, "checkpoint");
    await mkdir(checkpoint);
    const missingLaya = layaTestEnv({ PI_SESSION_MEMORY_PYTHON: python, PI_SESSION_MEMORY_LAYA_CHECKPOINT: checkpoint });
    assert.equal(missingLaya.ready, false);
    if (!missingLaya.ready) assert.match(missingLaya.reason, /^Laya runtime unavailable: laya is not importable/);

    const readyPython = resolve(root, "ready-python");
    await writeFile(readyPython, "#!/bin/sh\nexit 0\n");
    await chmod(readyPython, 0o755);
    const ready = layaTestEnv({
      PI_SESSION_MEMORY_PYTHON: readyPython,
      PI_SESSION_MEMORY_LAYA_CHECKPOINT: checkpoint,
      HF_HOME: resolve(root, "hf"),
    });
    assert.equal(ready.ready, true);
    if (ready.ready) {
      assert.equal(ready.python, readyPython);
      assert.equal(ready.env.HF_HUB_OFFLINE, "1");
      assert.equal(ready.env.TRANSFORMERS_OFFLINE, "1");
      assert.equal(ready.env.USE_TF, "0");
      assert.equal(ready.env.TOKENIZERS_PARALLELISM, "false");
      assert.equal(ready.env.HF_HOME, resolve(root, "hf"));
      assert.equal(ready.env.HF_HUB_CACHE, undefined);
      assert.equal(ready.env.PI_SESSION_MEMORY_LAYA_CHECKPOINT, checkpoint);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
