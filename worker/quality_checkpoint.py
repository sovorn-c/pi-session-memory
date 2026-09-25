"""Run the labeled, pinned-target memory-question checkpoint."""

from contextlib import redirect_stdout
import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import sys
import time

from worker.laya_runtime import LayaEvaluator, RuntimeContext
from worker.protocol import GateRequest, ProtocolError, parse_request


@dataclass(frozen=True)
class LabeledCase:
    request: GateRequest
    expected: bool
    rationale: str


@dataclass(frozen=True)
class CaseResult:
    case_id: str
    actual: bool | None
    p_true: float | None
    confidence: float | None
    elapsed_ms: float
    error: str | None


def load_cases(path: Path) -> list[LabeledCase]:
    cases = []
    seen_ids: set[str] = set()
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        payload: object = json.loads(line)
        if not isinstance(payload, dict) or set(payload) != {"case_id", "gate", "state", "expected", "rationale"}:
            raise ValueError(f"case line {line_number} does not match the labeled fixture schema")
        case_id = payload["case_id"]
        expected = payload["expected"]
        rationale = payload["rationale"]
        if not isinstance(case_id, str) or not case_id or case_id in seen_ids:
            raise ValueError(f"case line {line_number} has a missing or repeated case id")
        if type(expected) is not bool or not isinstance(rationale, str):
            raise ValueError(f"case line {line_number} has an invalid expected label or rationale")
        request_payload = {
            "protocol_version": 1,
            "request_id": case_id,
            "gate": payload["gate"],
            "state": payload["state"],
        }
        try:
            request = parse_request(json.dumps(request_payload, ensure_ascii=False).encode("utf-8"))
        except (ProtocolError, UnicodeEncodeError) as error:
            raise ValueError(f"case line {line_number} has an invalid bounded gate request") from error
        seen_ids.add(case_id)
        cases.append(LabeledCase(request=request, expected=expected, rationale=rationale))
    if not cases:
        raise ValueError("labeled fixture has no cases")
    return cases


def _format_bool(value: bool | None) -> str:
    if value is None:
        return "error"
    return "accept" if value else "reject"


def _runtime_markdown(context: RuntimeContext) -> list[str]:
    warning_lines = [f"- {warning}" for warning in context.warnings] or ["- None observed during model load."]
    return [
        "## Target/runtime context",
        "",
        f"- Python: `{context.python_version}`",
        f"- Laya distribution: `{context.laya_version}`",
        f"- Upstream source commit: `{context.laya_source_commit}`",
        f"- Checkpoint revision: `{context.checkpoint_revision}`",
        f"- `model.safetensors` SHA-256: `{context.checkpoint_sha256}`",
        f"- Device used: `{context.device}` (MPS available: `{str(context.mps_available).lower()}`)",
        f"- Model load: `{context.load_ms:.2f} ms`",
        f"- Peak resident set at model-load completion: `{context.max_rss_bytes} bytes`",
        "- Laya load warnings:",
        *warning_lines,
        "",
    ]


def render_report(cases: list[LabeledCase], results: list[CaseResult], context: RuntimeContext) -> str:
    errors = [result for result in results if result.actual is None]
    rows = [
        "| Case | Gate | Expected | Actual | Match | P(true) | Confidence | Decision time | Rationale |",
        "|---|---|---|---|---:|---:|---:|---:|---|",
    ]
    for case, result in zip(cases, results):
        expected = _format_bool(case.expected)
        actual = _format_bool(result.actual)
        matched = "yes" if result.actual is not None and result.actual == case.expected else "no"
        probability = "—" if result.p_true is None else f"{result.p_true:.4f}"
        confidence = "—" if result.confidence is None else f"{result.confidence:.4f}"
        rationale = case.rationale.replace("|", "\\|").replace("\n", " ")
        rows.append(
            f"| `{case.request.request_id}` | {case.request.gate} | {expected} | {actual} | {matched} | "
            f"{probability} | {confidence} | {result.elapsed_ms:.2f} ms | {rationale} |"
        )

    report = [
        "# E01 labeled memory-question checkpoint",
        "",
        "This records target decisions for the labeled cases. It is not SC-07, does not define a numerical acceptance cutoff, and does not assign a GO/no-go disposition.",
        "",
        *_runtime_markdown(context),
        "## Cases and actual judgments",
        "",
        *rows,
        "",
        "## Errors and omissions",
        "",
    ]
    if errors:
        report.extend(f"- `{result.case_id}`: {result.error}" for result in errors)
    else:
        report.append("- None; every case produced a typed Laya decision.")

    matches = sum(
        result.actual is not None and result.actual == case.expected
        for case, result in zip(cases, results)
    )
    report.extend(
        [
            "",
            f"- Label agreement observed: `{matches}/{len(cases)}` cases. This count is descriptive only; no cutoff is inferred.",
            "",
            "## Uncertainty and disposition",
            "",
            "Laya's per-case confidence is reported above as model output, not as calibrated certainty. Review the target warning and individual judgments before deciding fit; this report cannot determine whether errors or evidence volume are material.",
            "",
            "**Human GO/no-go disposition required before work beyond the minimal gate. No disposition is inferred here.**",
            "",
        ]
    )
    return "\n".join(report)


def run_checkpoint(cases: list[LabeledCase], evaluator: LayaEvaluator) -> list[CaseResult]:
    results = []
    for case in cases:
        started = time.perf_counter()
        try:
            decision = evaluator.evaluate(case.request)
            result = CaseResult(
                case_id=case.request.request_id,
                actual=decision.accepted,
                p_true=decision.p_true,
                confidence=decision.confidence,
                elapsed_ms=round((time.perf_counter() - started) * 1000.0, 2),
                error=None,
            )
        except Exception as error:
            result = CaseResult(
                case_id=case.request.request_id,
                actual=None,
                p_true=None,
                confidence=None,
                elapsed_ms=round((time.perf_counter() - started) * 1000.0, 2),
                error=f"{type(error).__name__}: {str(error)[:240]}",
            )
        results.append(result)
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        cases = load_cases(args.cases)
        with redirect_stdout(sys.stderr):
            evaluator = LayaEvaluator()
    except Exception as error:
        print(f"Checkpoint could not start ({type(error).__name__}).", file=sys.stderr)
        return 1

    results = run_checkpoint(cases, evaluator)
    report = render_report(cases, results, evaluator.context)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(report, encoding="utf-8")
    errors = sum(result.actual is None for result in results)
    print(f"Checkpoint report written to {args.report}; judgments={len(results)}, errors={errors}; human review required.")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
