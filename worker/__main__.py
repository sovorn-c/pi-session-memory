"""Run one persistent JSONL worker process."""

from contextlib import redirect_stdout
import sys

from worker.laya_runtime import LayaEvaluator
from worker.protocol import serve


def main() -> int:
    try:
        with redirect_stdout(sys.stderr):
            evaluator = LayaEvaluator()
    except Exception as error:
        print(f"Laya worker startup failed ({type(error).__name__}).", file=sys.stderr, flush=True)
        return 1

    serve(sys.stdin.buffer, sys.stdout.buffer, sys.stderr, evaluator.evaluate)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
