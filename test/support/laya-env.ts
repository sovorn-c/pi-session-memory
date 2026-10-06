import { spawnSync } from "node:child_process";
import { constants, statSync } from "node:fs";

export interface ReadyLayaTestEnv {
  ready: true;
  python: string;
  env: NodeJS.ProcessEnv;
}

export interface MissingLayaTestEnv {
  ready: false;
  reason: string;
}

export type LayaTestEnv = ReadyLayaTestEnv | MissingLayaTestEnv;

function isExecutableFile(path: string): boolean {
  try {
    const info = statSync(path);
    return info.isFile() && (info.mode & constants.X_OK) !== 0;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function layaTestEnv(env: NodeJS.ProcessEnv = process.env): LayaTestEnv {
  const python = env.PI_SESSION_MEMORY_PYTHON;
  if (!python || !isExecutableFile(python)) {
    return { ready: false, reason: "Laya runtime unavailable: PI_SESSION_MEMORY_PYTHON is not an executable file" };
  }
  const checkpoint = env.PI_SESSION_MEMORY_LAYA_CHECKPOINT;
  if (!checkpoint || !isDirectory(checkpoint)) {
    return { ready: false, reason: "Laya runtime unavailable: PI_SESSION_MEMORY_LAYA_CHECKPOINT is not a directory" };
  }
  const probe = spawnSync(python, ["-c", "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('laya') else 1)"], {
    encoding: "utf8",
    env: { PATH: env.PATH, HOME: env.HOME, PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (probe.status !== 0) {
    return { ready: false, reason: "Laya runtime unavailable: laya is not importable" };
  }
  const child: NodeJS.ProcessEnv = {
    PI_SESSION_MEMORY_PYTHON: python,
    PI_SESSION_MEMORY_LAYA_CHECKPOINT: checkpoint,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    USE_TF: "0",
    TOKENIZERS_PARALLELISM: "false",
  };
  if (env.HF_HOME) child.HF_HOME = env.HF_HOME;
  if (env.HF_HUB_CACHE) child.HF_HUB_CACHE = env.HF_HUB_CACHE;
  return { ready: true, python, env: child };
}
