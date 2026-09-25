"""Pinned Laya decision adapter used by both the JSONL worker and quality check."""

from dataclasses import dataclass
import hashlib
import importlib.metadata
import inspect
import json
import math
import os
from pathlib import Path
import resource
import subprocess
import sys
import time
from urllib.parse import unquote, urlparse
import warnings

from worker.protocol import Gate, GateDecision, GateRequest


LAYA_SOURCE_COMMIT = "010bacef009c855ccba814b51f7c8e1d38ab5e3f"
CHECKPOINT_REVISION = "f9ab0b228f0fc0f14d873dbc99038f135c2da1b2"
CHECKPOINT_SHA256 = "4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e"
DEFAULT_CHECKPOINT = (
    Path.home()
    / ".cache/pi-session-memory/bp-init-laya-010bacef/hf/hub/models--convaiinnovations--laya-typed-decisions/snapshots"
    / CHECKPOINT_REVISION
)
Question = dict[str, str | dict[str, str]]
QUESTIONS: dict[Gate, Question] = {
    "observation": {
        "type": "noul",
        "instructions": (
            "Does this single session turn contain a durable user decision, constraint, unresolved commitment, "
            "or project fact likely to matter later? Answer yes only for concrete reusable evidence; do not "
            "retain small talk, transient status, or unsupported inference."
        ),
        "criteria": {
            "true": "The turn contains a concrete durable fact, decision, constraint, or commitment worth retaining.",
            "false": "The turn is transient, routine, unsupported, or has no likely future value.",
        },
    },
    "reflection": {
        "type": "noul",
        "instructions": (
            "Do these linked observations together establish a stable recurring decision or insight across turns "
            "that is not already captured by any one observation? Answer yes only when the evidence supports a "
            "cross-turn synthesis; unrelated facts or a single isolated observation are not mature."
        ),
        "criteria": {
            "true": "Multiple observations support a stable, useful cross-turn synthesis.",
            "false": "Evidence is unrelated, isolated, transient, or does not support a distinct synthesis.",
        },
    },
}


@dataclass(frozen=True)
class RuntimeContext:
    python_version: str
    laya_version: str
    laya_source_commit: str
    checkpoint_revision: str
    checkpoint_sha256: str
    device: str
    mps_available: bool
    load_ms: float
    max_rss_bytes: int
    warnings: tuple[str, ...]


def _verified_checkpoint() -> Path:
    checkpoint = Path(os.environ.get("PI_SESSION_MEMORY_LAYA_CHECKPOINT", DEFAULT_CHECKPOINT)).expanduser().resolve()
    if checkpoint.name != CHECKPOINT_REVISION:
        raise RuntimeError("checkpoint revision mismatch")
    weights = checkpoint / "model.safetensors"
    with weights.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != CHECKPOINT_SHA256:
        raise RuntimeError("checkpoint weights mismatch")
    return checkpoint


def _verified_source(distribution: importlib.metadata.Distribution, loaded_agent_path: Path) -> None:
    metadata_text = distribution.read_text("direct_url.json")
    if metadata_text is None:
        raise RuntimeError("Laya source origin is unavailable")
    source_url = json.loads(metadata_text).get("url")
    parsed_url = urlparse(source_url) if isinstance(source_url, str) else None
    if parsed_url is None or parsed_url.scheme != "file":
        raise RuntimeError("Laya source is not the pinned local checkout")
    source_root = Path(unquote(parsed_url.path)).resolve()

    commit = subprocess.run(
        ["git", "-C", str(source_root), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if commit != LAYA_SOURCE_COMMIT:
        raise RuntimeError("Laya source commit mismatch")
    clean = subprocess.run(
        ["git", "-C", str(source_root), "diff", "--quiet", "HEAD", "--", "laya"],
        check=False,
        capture_output=True,
    )
    if clean.returncode != 0:
        raise RuntimeError("Laya source checkout is modified")

    installed_root = loaded_agent_path.parent
    for filename in ("__init__.py", "agent.py", "common.py"):
        if (installed_root / filename).read_bytes() != (source_root / "laya" / filename).read_bytes():
            raise RuntimeError("installed Laya code differs from the pinned source")


def _probability(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise ValueError("Laya returned a non-numeric probability")
    result = float(value)
    if not math.isfinite(result) or not 0.0 <= result <= 1.0:
        raise ValueError("Laya returned an invalid probability")
    return result


class LayaEvaluator:
    def __init__(self) -> None:
        from laya.agent import Agent
        import torch

        distribution = importlib.metadata.distribution("laya")
        if distribution.version != "0.3.7":
            raise RuntimeError("Laya distribution version mismatch")
        _verified_source(distribution, Path(inspect.getfile(Agent)).resolve())
        checkpoint = _verified_checkpoint()

        start = time.perf_counter()
        with warnings.catch_warnings(record=True) as captured_warnings:
            warnings.simplefilter("always")
            self.agent = Agent(str(checkpoint))
        load_ms = (time.perf_counter() - start) * 1000.0
        max_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        max_rss_bytes = int(max_rss if sys.platform == "darwin" else max_rss * 1024)
        mps_available = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
        self.context = RuntimeContext(
            python_version=sys.version.split()[0],
            laya_version=distribution.version,
            laya_source_commit=LAYA_SOURCE_COMMIT,
            checkpoint_revision=CHECKPOINT_REVISION,
            checkpoint_sha256=CHECKPOINT_SHA256,
            device=str(self.agent.device),
            mps_available=bool(mps_available),
            load_ms=round(load_ms, 2),
            max_rss_bytes=max_rss_bytes,
            warnings=tuple(str(warning.message) for warning in captured_warnings),
        )

    def evaluate(self, request: GateRequest) -> GateDecision:
        result = self.agent.system_one(
            {"gate": request.gate, "evidence": request.state},
            {"warranted": QUESTIONS[request.gate]},
        )
        answers = result.get("answers")
        if not isinstance(answers, dict):
            raise ValueError("Laya returned no typed answers")
        answer = answers.get("warranted")
        if not isinstance(answer, dict) or answer.get("type") != "noul":
            raise ValueError("Laya returned an unexpected decision type")
        p_true = _probability(answer.get("noul"))
        confidence = _probability(answer.get("confidence"))
        return GateDecision(accepted=p_true >= 0.5, p_true=round(p_true, 4), confidence=round(confidence, 4))
