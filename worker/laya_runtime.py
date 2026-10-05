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

from worker.protocol import Gate, GateDecision, GateRequest, ProjectionDecision


LAYA_SOURCE_COMMIT = "010bacef009c855ccba814b51f7c8e1d38ab5e3f"
CHECKPOINT_REVISION = "f9ab0b228f0fc0f14d873dbc99038f135c2da1b2"
CHECKPOINT_SHA256 = "4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e"
DEFAULT_CHECKPOINT = (
    Path.home()
    / ".cache/pi-session-memory/bp-init-laya-010bacef/hf/hub/models--convaiinnovations--laya-typed-decisions/snapshots"
    / CHECKPOINT_REVISION
)
Question = dict[str, str | dict[str, str]]
MAX_PROJECTION_CANDIDATES = 8
MAX_PROJECTION_NEED_CHARS = 800
MAX_CANDIDATE_TEXT_CHARS = 500
MAX_MEMORY_TEXT_CHARS = 1_000
MAX_SUPERSESSION_SOURCES = 12
MAX_ENTRY_ID_CHARS = 256
MAX_SUPERSESSION_SOURCE_TEXT_CHARS = 5_000
NO_CANDIDATE = "none"
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
    "resident": {
        "type": "noul",
        "instructions": (
            "Is the already resident, linked session memory sufficient to address this current need without "
            "retrieving another memory entry? Answer yes only when its evidence directly covers the request."
        ),
        "criteria": {
            "true": "The resident source-linked memory directly covers the current need.",
            "false": "The resident memory is insufficient or unrelated to the current need.",
        },
    },
    "supersession": {
        "type": "noul",
        "instructions": (
            "Does the exact linked newer session evidence explicitly establish that the old memory has been "
            "reversed, corrected, or replaced? Do not treat recency, unrelated facts, an additive detail, or "
            "uncertainty as supersession; the newer evidence must actually supersede the old claim."
        ),
        "criteria": {
            "true": "The exact linked newer evidence explicitly contradicts or replaces the old memory; supersession is established.",
            "false": "Supersession is not established: evidence is later only, unrelated, additive, ambiguous, or insufficient.",
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


def _projection_state(state: str) -> tuple[str, list[tuple[str, str, str]]]:
    try:
        value: object = json.loads(state)
    except json.JSONDecodeError:
        raise ValueError("projection state is invalid JSON") from None
    if not isinstance(value, dict) or set(value) != {"need", "candidates"}:
        raise ValueError("projection state fields are invalid")
    need = value["need"]
    candidates = value["candidates"]
    if not isinstance(need, str) or not need or len(need) > MAX_PROJECTION_NEED_CHARS:
        raise ValueError("projection need is invalid")
    if not isinstance(candidates, list) or not candidates or len(candidates) > MAX_PROJECTION_CANDIDATES:
        raise ValueError("projection candidates are empty or exceed the bound")

    parsed: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not isinstance(candidate, dict) or set(candidate) != {"entryId", "kind", "text"}:
            raise ValueError("projection candidate fields are invalid")
        entry_id = candidate["entryId"]
        kind = candidate["kind"]
        text = candidate["text"]
        if (
            not isinstance(entry_id, str)
            or not entry_id
            or len(entry_id) > 256
            or entry_id in seen
            or kind not in ("observation", "reflection")
            or not isinstance(text, str)
            or not text
            or len(text) > MAX_CANDIDATE_TEXT_CHARS
        ):
            raise ValueError("projection candidate is invalid")
        seen.add(entry_id)
        parsed.append((entry_id, kind, text))
    return need, parsed


def _supersession_state(state: str) -> None:
    if len(state.encode("utf-8")) > 8_192:
        raise ValueError("supersession state exceeds its byte bound")
    try:
        value: object = json.loads(state)
    except json.JSONDecodeError:
        raise ValueError("supersession state is invalid JSON") from None
    if not isinstance(value, dict) or set(value) != {"oldMemory", "newEvidence"}:
        raise ValueError("supersession state fields are invalid")
    old_memory = value["oldMemory"]
    evidence = value["newEvidence"]
    if not isinstance(old_memory, dict) or set(old_memory) != {"entryId", "kind", "text"}:
        raise ValueError("supersession old memory fields are invalid")
    if (
        not _valid_entry_id(old_memory["entryId"])
        or old_memory["kind"] not in ("observation", "reflection")
        or not _valid_memory_text(old_memory["text"])
    ):
        raise ValueError("supersession old memory is invalid")
    if not isinstance(evidence, dict) or set(evidence) != {"entryId", "text", "sourceEntryIds", "sources"}:
        raise ValueError("supersession newer evidence fields are invalid")
    source_ids = evidence["sourceEntryIds"]
    sources = evidence["sources"]
    if (
        not _valid_entry_id(evidence["entryId"])
        or evidence["entryId"] == old_memory["entryId"]
        or not _valid_memory_text(evidence["text"])
        or not isinstance(source_ids, list)
        or not source_ids
        or len(source_ids) > MAX_SUPERSESSION_SOURCES
        or not all(_valid_entry_id(entry_id) for entry_id in source_ids)
        or len(set(source_ids)) != len(source_ids)
        or evidence["entryId"] in source_ids
        or old_memory["entryId"] in source_ids
        or not isinstance(sources, list)
        or len(sources) != len(source_ids)
    ):
        raise ValueError("supersession newer evidence is invalid")
    for expected_id, source in zip(source_ids, sources, strict=True):
        if (
            not isinstance(source, dict)
            or set(source) != {"entryId", "role", "text"}
            or source["entryId"] != expected_id
            or source["role"] not in ("user", "assistant", "toolResult")
            or not isinstance(source["text"], str)
            or len(source["text"]) > MAX_SUPERSESSION_SOURCE_TEXT_CHARS
        ):
            raise ValueError("supersession source link is invalid")


def _valid_entry_id(value: object) -> bool:
    return isinstance(value, str) and 0 < len(value) <= MAX_ENTRY_ID_CHARS


def _valid_memory_text(value: object) -> bool:
    return isinstance(value, str) and 0 < len(value) <= MAX_MEMORY_TEXT_CHARS


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

    def evaluate(self, request: GateRequest) -> GateDecision | ProjectionDecision:
        if request.gate == "projection":
            return self._select_projection(request)
        if request.gate == "supersession":
            _supersession_state(request.state)
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

    def _select_projection(self, request: GateRequest) -> ProjectionDecision:
        need, candidates = _projection_state(request.state)
        labels = {f"candidate_{index}": f"{kind}: {text}" for index, (_, kind, text) in enumerate(candidates)}
        labels[NO_CANDIDATE] = "None of these source-linked memories is relevant to the current need."
        result = self.agent.system_one(
            {"gate": request.gate, "current_need": need},
            {
                "selected": {
                    "type": "choice",
                    "instructions": "Which one bounded memory candidate is most relevant to the current need? Select none if no candidate is relevant.",
                    "criteria": labels,
                },
            },
        )
        answers = result.get("answers")
        if not isinstance(answers, dict):
            raise ValueError("Laya returned no typed selection")
        answer = answers.get("selected")
        if not isinstance(answer, dict) or answer.get("type") != "choice":
            raise ValueError("Laya returned an unexpected selection type")
        selected = answer.get("choice")
        if selected == NO_CANDIDATE:
            return ProjectionDecision(selected_entry_id=None)
        if not isinstance(selected, str) or not selected.startswith("candidate_"):
            raise ValueError("Laya returned an unknown selection")
        try:
            index = int(selected.removeprefix("candidate_"))
        except ValueError:
            raise ValueError("Laya returned an unknown selection") from None
        if index < 0 or index >= len(candidates) or selected != f"candidate_{index}":
            raise ValueError("Laya returned an unknown selection")
        return ProjectionDecision(selected_entry_id=candidates[index][0])
