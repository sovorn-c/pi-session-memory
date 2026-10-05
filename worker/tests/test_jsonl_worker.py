import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import unittest

from worker.laya_runtime import LayaEvaluator
from worker.protocol import GateRequest, parse_request, serve


PROJECT_ROOT = Path(__file__).resolve().parents[2]


class SupersessionGateTests(unittest.TestCase):
    def setUp(self):
        self.state = {
            "oldMemory": {"entryId": "observation-old", "kind": "observation", "text": "The old policy is enabled."},
            "newEvidence": {
                "entryId": "observation-new",
                "text": "The prior policy has been replaced.",
                "sourceEntryIds": ["raw-new"],
                "sources": [{"entryId": "raw-new", "role": "user", "text": "New exact evidence."}],
            },
        }
        self.state_text = json.dumps(self.state)

    def test_jsonl_protocol_routes_bounded_supersession_decision(self):
        captured = {}

        class FakeAgent:
            def system_one(self, evidence, decisions):
                captured["evidence"] = evidence
                captured["decisions"] = decisions
                return {"answers": {"warranted": {"type": "noul", "noul": 0.95, "confidence": 0.9}}}

        evaluator = object.__new__(LayaEvaluator)
        evaluator.agent = FakeAgent()
        request = {
            "protocol_version": 1,
            "request_id": "supersession-1",
            "gate": "supersession",
            "state": self.state_text,
        }
        output = io.BytesIO()
        serve(io.BytesIO(json.dumps(request).encode() + b"\n"), output, io.StringIO(), evaluator.evaluate)
        response = json.loads(output.getvalue())

        self.assertEqual(response["status"], "ok")
        self.assertEqual(response["gate"], "supersession")
        self.assertEqual(response["decision"], {"accepted": True, "p_true": 0.95, "confidence": 0.9})
        self.assertEqual(captured["evidence"], {"gate": "supersession", "evidence": self.state_text})
        question = captured["decisions"]["warranted"]
        self.assertIn("supersede", question["instructions"])
        self.assertIn("Do not treat recency", question["instructions"])
        self.assertIn("explicitly contradicts or replaces", question["criteria"]["true"])
        self.assertIn("not established", question["criteria"]["false"])

    def test_supersession_gate_rejects_invalid_links_before_calling_laya(self):
        class FakeAgent:
            def system_one(self, *_args):
                raise AssertionError("invalid bounded evidence must not reach Laya")

        evaluator = object.__new__(LayaEvaluator)
        evaluator.agent = FakeAgent()
        request = GateRequest("supersession-invalid", "supersession", json.dumps({
            **self.state,
            "newEvidence": {**self.state["newEvidence"], "sourceEntryIds": ["raw-other"]},
        }))

        with self.assertRaisesRegex(ValueError, "supersession"):
            evaluator.evaluate(request)

    def test_protocol_parser_accepts_supersession_requests(self):
        request = parse_request(json.dumps({
            "protocol_version": 1,
            "request_id": "supersession-parse",
            "gate": "supersession",
            "state": self.state_text,
        }).encode())

        self.assertEqual(request.gate, "supersession")
        self.assertEqual(request.state, self.state_text)


class JsonlWorkerIntegrationTests(unittest.TestCase):
    def test_unsupported_python_version_exits_before_importing_worker_adapters(self):
        env = os.environ.copy()
        env["PI_SESSION_MEMORY_PYTHON"] = "configured-python3.9"
        script = """
import builtins
import runpy
import sys

sys.version_info = (3, 9, 6, "final", 0)
original_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name in {"worker.protocol", "worker.laya_runtime"}:
        raise RuntimeError("worker adapter imported before interpreter guard")
    return original_import(name, *args, **kwargs)
builtins.__import__ = guarded_import
try:
    runpy.run_module("worker", run_name="__main__")
except SystemExit as error:
    sys.exit(error.code)
"""
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=PROJECT_ROOT,
            env=env,
            capture_output=True,
            check=False,
        )

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(
            result.stderr.decode(errors="replace"),
            "Laya worker requires Python 3.11; set PI_SESSION_MEMORY_PYTHON to a Python 3.11 interpreter.\n",
        )

    def test_one_process_serves_bounded_formation_and_projection_requests(self):
        env = os.environ.copy()
        env.update(
            {
                "HF_HOME": "/Users/sovorn/.cache/pi-session-memory/bp-init-laya-010bacef/hf",
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
                "USE_TF": "0",
                "TOKENIZERS_PARALLELISM": "false",
            }
        )
        projection_state = json.dumps(
            {
                "need": "Which earlier decision keeps Pi session provenance exact while projecting only needed memory?",
                "candidates": [
                    {
                        "entryId": "observation-relevant",
                        "kind": "observation",
                        "text": "Keep the Pi session canonical and append-only. Link observations to exact raw session entry IDs on the active branch; project only selected memory into request-local context without mutating history.",
                    },
                    {
                        "entryId": "observation-unrelated",
                        "kind": "observation",
                        "text": "The UI theme can be changed in settings and the terminal supports multiple color palettes.",
                    },
                ],
            }
        )
        requests = [
            b'{"protocol_version":1,"request_id":"bad-json","gate":\n',
            b"x" * 20_000 + b"\n",
            json.dumps(
                {
                    "protocol_version": 1,
                    "request_id": "observation-1",
                    "gate": "observation",
                    "state": "A user decided that the Pi session remains canonical and every retained observation must cite exact source entry IDs.",
                }
            ).encode()
            + b"\n",
            json.dumps(
                {
                    "protocol_version": 1,
                    "request_id": "reflection-1",
                    "gate": "reflection",
                    "state": "Across three turns, the user repeatedly chose exact source links, append-only history, and native Pi context whenever memory is uncertain.",
                }
            ).encode()
            + b"\n",
            json.dumps(
                {
                    "protocol_version": 1,
                    "request_id": "projection-1",
                    "gate": "projection",
                    "state": projection_state,
                }
            ).encode()
            + b"\n",
        ]

        result = subprocess.run(
            [sys.executable, "-m", "worker"],
            cwd=PROJECT_ROOT,
            env=env,
            input=b"".join(requests),
            capture_output=True,
            check=False,
            timeout=180,
        )

        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), len(requests), result.stdout.decode(errors="replace"))
        self.assertLessEqual(max(map(len, lines)), 2_048)
        responses = [json.loads(line) for line in lines]
        self.assertEqual([response["protocol_version"] for response in responses], [1, 1, 1, 1, 1])
        self.assertEqual([response["status"] for response in responses], ["error", "error", "ok", "ok", "ok"])
        self.assertEqual(responses[0]["error"]["code"], "invalid_json")
        self.assertEqual(responses[1]["error"]["code"], "request_too_large")
        self.assertEqual([response["request_id"] for response in responses[2:]], ["observation-1", "reflection-1", "projection-1"])
        self.assertEqual([response["gate"] for response in responses[2:]], ["observation", "reflection", "projection"])
        self.assertEqual(responses[4]["decision"], {"selected_entry_id": "observation-relevant"})
        for response in responses[2:4]:
            self.assertEqual(response["status"], "ok")
            self.assertIsInstance(response["decision"]["accepted"], bool)
            self.assertTrue(math.isfinite(response["decision"]["p_true"]))
            self.assertGreaterEqual(response["decision"]["p_true"], 0.0)
            self.assertLessEqual(response["decision"]["p_true"], 1.0)


if __name__ == "__main__":
    unittest.main()
