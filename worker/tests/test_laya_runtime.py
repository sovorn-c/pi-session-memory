import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

from worker.laya_runtime import (
    CHECKPOINT_REPO,
    CHECKPOINT_REVISION,
    CHECKPOINT_SHA256,
    LAYA_SOURCE_COMMIT,
    _verified_checkpoint,
    _verified_source,
    checkpoint_directory,
)


WORKER_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = WORKER_DIR.parent
ALLOWED_ENV_NAMES = {
    "PI_SESSION_MEMORY_LAYA_CHECKPOINT",
    "HF_HUB_CACHE",
    "HF_HOME",
    "XDG_CACHE_HOME",
}


def snapshot(home: Path) -> Path:
    return home / ".cache" / "huggingface" / "hub" / CHECKPOINT_REPO / "snapshots" / CHECKPOINT_REVISION


class FakeDistribution:
    def __init__(self, text: str | None) -> None:
        self.text = text

    def read_text(self, filename: str) -> str | None:
        if filename != "direct_url.json":
            return None
        return self.text


def git_result(stdout: str = "", code: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=["git"], returncode=code, stdout=stdout, stderr="")


def assert_closed(test: unittest.TestCase, error: BaseException, *forbidden: str) -> None:
    message = str(error)
    for item in (LAYA_SOURCE_COMMIT, *forbidden):
        test.assertNotIn(item, message)
        test.assertNotIn(item.upper(), message)


class CheckpointDirectoryTests(unittest.TestCase):
    def test_resolution_precedence_revision_and_weights(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            hf_home = Path(tmp) / "hf"
            hub = Path(tmp) / "hub"
            xdg = Path(tmp) / "xdg"
            explicit = Path(tmp) / "explicit" / CHECKPOINT_REVISION
            self.assertEqual(checkpoint_directory({}, home), snapshot(home))
            self.assertEqual(
                checkpoint_directory({"HF_HOME": str(hf_home)}, home),
                hf_home / "hub" / CHECKPOINT_REPO / "snapshots" / CHECKPOINT_REVISION,
            )
            self.assertEqual(
                checkpoint_directory({"HF_HUB_CACHE": str(hub), "HF_HOME": str(hf_home), "XDG_CACHE_HOME": str(xdg)}, home),
                hub / CHECKPOINT_REPO / "snapshots" / CHECKPOINT_REVISION,
            )
            self.assertEqual(
                checkpoint_directory({"XDG_CACHE_HOME": str(xdg), "HF_HOME": ""}, home),
                xdg / "huggingface" / "hub" / CHECKPOINT_REPO / "snapshots" / CHECKPOINT_REVISION,
            )
            self.assertEqual(
                checkpoint_directory({"PI_SESSION_MEMORY_LAYA_CHECKPOINT": str(explicit), "HF_HUB_CACHE": str(hub)}, home),
                explicit,
            )
            self.assertEqual(
                checkpoint_directory({"PI_SESSION_MEMORY_LAYA_CHECKPOINT": f"~/{CHECKPOINT_REVISION}"}, home),
                home / CHECKPOINT_REVISION,
            )

            wrong = Path(tmp) / "wrong-name"
            wrong.mkdir()
            with self.assertRaisesRegex(RuntimeError, "checkpoint revision mismatch"):
                _verified_checkpoint({"PI_SESSION_MEMORY_LAYA_CHECKPOINT": str(wrong)}, home)

            missing = Path(tmp) / "missing" / CHECKPOINT_REVISION
            missing.mkdir(parents=True)
            with self.assertRaisesRegex(RuntimeError, re.escape(str(missing / "model.safetensors"))):
                _verified_checkpoint({"PI_SESSION_MEMORY_LAYA_CHECKPOINT": str(missing)}, home)

            weights = explicit / "model.safetensors"
            weights.parent.mkdir(parents=True)
            weights.write_bytes(b"not-the-weights")
            with self.assertRaisesRegex(RuntimeError, "checkpoint weights mismatch"):
                _verified_checkpoint({"PI_SESSION_MEMORY_LAYA_CHECKPOINT": str(explicit)}, home)
            self.assertEqual(
                _verified_checkpoint(
                    {"PI_SESSION_MEMORY_LAYA_CHECKPOINT": str(explicit)},
                    home,
                    digest=lambda _path: CHECKPOINT_SHA256,
                ),
                explicit.resolve(),
            )

    def test_hub_cache_matches_huggingface_hub_for_each_env_case(self) -> None:
        cases = [
            {},
            {"HF_HOME": "/tmp/pi-session-memory-hf-home"},
            {"HF_HUB_CACHE": "/tmp/pi-session-memory-hub", "HF_HOME": "/tmp/pi-session-memory-hf-home"},
            {"XDG_CACHE_HOME": "/tmp/pi-session-memory-xdg"},
        ]
        script = """
import json
from huggingface_hub import constants
from worker.laya_runtime import checkpoint_directory
print(json.dumps({"hf": constants.HF_HUB_CACHE, "ours": str(checkpoint_directory().parents[2])}))
"""
        for case in cases:
            env = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}
            env.update(case)
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            env["HF_HUB_OFFLINE"] = "1"
            env["TRANSFORMERS_OFFLINE"] = "1"
            result = subprocess.run(
                [os.environ.get("PYTHON", "") or __import__("sys").executable, "-c", script],
                cwd=PROJECT_ROOT,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout.strip().splitlines()[-1])
            self.assertEqual(Path(payload["ours"]), Path(payload["hf"]))


class VerifiedSourceTests(unittest.TestCase):
    def test_accepts_pinned_vcs_metadata_without_git(self) -> None:
        calls: list[list[str]] = []

        def runner(_root: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
            calls.append(args)
            return git_result(LAYA_SOURCE_COMMIT)

        for commit in (LAYA_SOURCE_COMMIT, LAYA_SOURCE_COMMIT.upper()):
            _verified_source(
                FakeDistribution(json.dumps({"url": "https://example.invalid/laya.git", "vcs_info": {"vcs": "git", "commit_id": commit}})),
                Path("/unused/agent.py"),
                git_runner=runner,
            )
        self.assertEqual(calls, [])

    def test_accepts_a_clean_local_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            installed = root / "installed"
            (source / "laya").mkdir(parents=True)
            installed.mkdir()
            for name in ("__init__.py", "agent.py", "common.py"):
                payload = f"{name}\n".encode()
                (source / "laya" / name).write_bytes(payload)
                (installed / name).write_bytes(payload)

            def runner(_checkout: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
                if args[0] == "rev-parse":
                    return git_result(f"{LAYA_SOURCE_COMMIT}\n")
                return git_result(code=0)

            _verified_source(
                FakeDistribution(json.dumps({"url": source.as_uri()})),
                installed / "agent.py",
                git_runner=runner,
            )

    def test_rejects_unpinned_or_damaged_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source"
            (source / "laya").mkdir(parents=True)
            other = "a" * 40
            short = LAYA_SOURCE_COMMIT[:12]
            cases = [
                (None, "Laya source origin is unavailable"),
                ("{", "Laya source origin is unavailable"),
                (json.dumps({"url": "https://example.invalid/laya.git"}), "Laya source is not the pinned local checkout"),
                (json.dumps({"url": 12}), "Laya source is not the pinned local checkout"),
                (json.dumps({"vcs_info": {"vcs": "git", "commit_id": other}}), "Laya source commit mismatch"),
                (json.dumps({"vcs_info": {"vcs": "git", "commit_id": short}}), "Laya source commit mismatch"),
                (json.dumps({"vcs_info": {"vcs": "git", "commit_id": short.upper()}}), "Laya source commit mismatch"),
                (json.dumps({"vcs_info": {"vcs": "git"}}), "Laya source is not the pinned local checkout"),
                (json.dumps({"vcs_info": {"vcs": "hg", "commit_id": LAYA_SOURCE_COMMIT}}), "Laya source is not the pinned local checkout"),
                (
                    json.dumps({"url": source.as_uri(), "vcs_info": {"vcs": "git", "commit_id": other}}),
                    "Laya source commit mismatch",
                ),
            ]
            for text, pattern in cases:
                with self.subTest(pattern=pattern, text=text):
                    def runner(_root: Path, _args: list[str]) -> subprocess.CompletedProcess[str]:
                        raise AssertionError("git must not run")

                    with self.assertRaises(RuntimeError) as caught:
                        _verified_source(FakeDistribution(text), Path("/unused/agent.py"), git_runner=runner)
                    self.assertEqual(str(caught.exception), pattern)
                    assert_closed(self, caught.exception, other, short, str(source))

            def dirty(_root: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
                if args[0] == "rev-parse":
                    return git_result(LAYA_SOURCE_COMMIT)
                return git_result(code=1)

            with self.assertRaisesRegex(RuntimeError, "Laya source checkout is modified") as dirty_error:
                _verified_source(FakeDistribution(json.dumps({"url": source.as_uri()})), Path("/unused/agent.py"), git_runner=dirty)
            assert_closed(self, dirty_error.exception, str(source))

            def wrong(_root: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
                if args[0] == "rev-parse":
                    return git_result(other)
                return git_result()

            with self.assertRaisesRegex(RuntimeError, "Laya source commit mismatch") as wrong_error:
                _verified_source(FakeDistribution(json.dumps({"url": source.as_uri()})), Path("/unused/agent.py"), git_runner=wrong)
            assert_closed(self, wrong_error.exception, other, str(source))


class WorkerEnvTests(unittest.TestCase):
    def test_worker_reads_only_the_allowed_env_names(self) -> None:
        pattern = re.compile(r"""_env_text\(\s*env\s*,\s*["']([A-Z0-9_]+)["']|os\.environ(?:\.get|\[)\(\s*["']([A-Z0-9_]+)["']""")
        found: set[str] = set()
        for path in WORKER_DIR.glob("*.py"):
            for match in pattern.finditer(path.read_text()):
                found.update(group for group in match.groups() if group)
        self.assertEqual(found, ALLOWED_ENV_NAMES)
