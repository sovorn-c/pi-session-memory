"""Run one persistent JSONL worker process."""

import sys


PYTHON_VERSION_ERROR = "Laya worker requires Python 3.11; set PI_SESSION_MEMORY_PYTHON to a Python 3.11 interpreter."


def main() -> int:
    if sys.version_info[:2] != (3, 11):
        print(PYTHON_VERSION_ERROR, file=sys.stderr, flush=True)
        return 1

    from contextlib import redirect_stdout

    from worker.laya_runtime import LayaEvaluator
    from worker.protocol import serve

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
