"""Bounded JSONL protocol for the pinned, session-local Laya gate worker."""

from contextlib import redirect_stdout
from dataclasses import asdict, dataclass
import json
import re
from typing import BinaryIO, Callable, Literal, TextIO, TypeAlias


Gate: TypeAlias = Literal["observation", "reflection", "resident", "projection", "supersession"]
ErrorCode: TypeAlias = Literal["invalid_json", "invalid_request", "request_too_large", "laya_error"]
PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 16_384
MAX_STATE_BYTES = 8_192
MAX_RESPONSE_BYTES = 2_048
_REQUEST_ID = re.compile(r"[A-Za-z0-9._:-]{1,64}\Z")


@dataclass(frozen=True)
class GateRequest:
    request_id: str
    gate: Gate
    state: str


@dataclass(frozen=True)
class GateDecision:
    accepted: bool
    p_true: float
    confidence: float


@dataclass(frozen=True)
class ProjectionDecision:
    selected_entry_id: str | None


@dataclass(frozen=True)
class ProtocolError(Exception):
    code: ErrorCode


def parse_request(line: bytes) -> GateRequest:
    try:
        payload: object = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ProtocolError("invalid_json") from None

    if not isinstance(payload, dict):
        raise ProtocolError("invalid_request")

    request_id = payload.get("request_id")
    if not isinstance(request_id, str) or not _REQUEST_ID.fullmatch(request_id):
        raise ProtocolError("invalid_request")
    if set(payload) != {"protocol_version", "request_id", "gate", "state"}:
        raise ProtocolError("invalid_request")
    if type(payload["protocol_version"]) is not int or payload["protocol_version"] != PROTOCOL_VERSION:
        raise ProtocolError("invalid_request")

    gate = payload["gate"]
    if gate == "observation":
        typed_gate: Gate = "observation"
    elif gate == "reflection":
        typed_gate = "reflection"
    elif gate == "resident":
        typed_gate = "resident"
    elif gate == "projection":
        typed_gate = "projection"
    elif gate == "supersession":
        typed_gate = "supersession"
    else:
        raise ProtocolError("invalid_request")
    state = payload["state"]
    if not isinstance(state, str) or not state or len(state.encode("utf-8")) > MAX_STATE_BYTES:
        raise ProtocolError("invalid_request")
    return GateRequest(request_id=request_id, gate=typed_gate, state=state)


def _error_response(code: ErrorCode, request_id: str | None = None) -> dict[str, object]:
    messages = {
        "invalid_json": "Request is not valid UTF-8 JSON.",
        "invalid_request": "Request fields do not match protocol version 1.",
        "request_too_large": "Request exceeds the configured byte limit.",
        "laya_error": "The Laya decision could not be trusted.",
    }
    return {
        "protocol_version": PROTOCOL_VERSION,
        "request_id": request_id,
        "status": "error",
        "error": {"code": code, "message": messages[code]},
    }


def _write_response(output: BinaryIO, payload: dict[str, object]) -> None:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8") + b"\n"
    if len(encoded) > MAX_RESPONSE_BYTES:
        encoded = json.dumps(_error_response("laya_error"), separators=(",", ":")).encode("utf-8") + b"\n"
    output.write(encoded)
    output.flush()


def _discard_line_remainder(input_stream: BinaryIO) -> None:
    while True:
        remainder = input_stream.readline(MAX_REQUEST_BYTES + 1)
        if not remainder or remainder.endswith(b"\n"):
            return


def serve(
    input_stream: BinaryIO,
    output_stream: BinaryIO,
    diagnostics: TextIO,
    evaluate: Callable[[GateRequest], GateDecision | ProjectionDecision],
) -> None:
    while line := input_stream.readline(MAX_REQUEST_BYTES + 1):
        if len(line) > MAX_REQUEST_BYTES:
            if not line.endswith(b"\n"):
                _discard_line_remainder(input_stream)
            _write_response(output_stream, _error_response("request_too_large"))
            continue

        try:
            request = parse_request(line.rstrip(b"\r\n"))
        except ProtocolError as error:
            _write_response(output_stream, _error_response(error.code))
            continue

        try:
            with redirect_stdout(diagnostics):
                decision = evaluate(request)
            response = {
                "protocol_version": PROTOCOL_VERSION,
                "request_id": request.request_id,
                "gate": request.gate,
                "status": "ok",
                "decision": asdict(decision),
            }
        except Exception as error:
            diagnostics.write(f"Laya gate failed ({type(error).__name__}).\n")
            response = _error_response("laya_error", request.request_id)
        _write_response(output_stream, response)
