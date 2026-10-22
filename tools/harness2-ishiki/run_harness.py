from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS2_ROOT = Path(os.environ.get("HARNESS2_ROOT", "D:/Codespace/references/harness2")).resolve()
if not (HARNESS2_ROOT / "harness2").is_dir():
    raise FileNotFoundError(f"Harness2 package not found under {HARNESS2_ROOT}; set HARNESS2_ROOT")
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HARNESS2_ROOT))

from adapter import IshikiBenchmarkAdapter
from harness2.core import schedule
from harness2.core.tree import read_tree


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Run Harness2 scenarios through a headless Ishiki runtime.")
    p.add_argument("--root", type=Path, default=HERE)
    p.add_argument("--runs-root", type=Path)
    p.add_argument("--list", action="store_true")
    p.add_argument("--validate", type=Path, metavar="HARNESS_DIR")
    p.add_argument("--run", dest="task", metavar="SCENARIO")
    p.add_argument("--harness", type=Path, metavar="HARNESS_DIR")
    p.add_argument("--run-id", default="manual")
    p.add_argument("--timeout", type=int, default=300)
    p.add_argument("--trajectory", type=Path, metavar="RUN_DIR")
    p.add_argument("--score", type=Path, metavar="RUN_DIR")
    p.add_argument("--score-task", metavar="SCENARIO")
    p.add_argument("--sweep-dry-run", action="store_true")
    p.add_argument("--sweep", action="store_true")
    p.add_argument("--split", choices=("all", "train", "test"), default="all")
    p.add_argument("--max-tasks", type=int)
    p.add_argument("--k", type=int, default=1)
    return p


def make_adapter(args: argparse.Namespace) -> IshikiBenchmarkAdapter:
    return IshikiBenchmarkAdapter(root=args.root, runs_root=args.runs_root)


def run_sweep_preview(adapter: IshikiBenchmarkAdapter, split: str, max_tasks: int | None) -> int:
    stream = schedule.task_stream(adapter, split=split, max_tasks=max_tasks)
    print(json.dumps({"benchmark": adapter.spec.name, "substrate": adapter.substrate.name, "domains": stream}, indent=2))
    return 0 if stream else 1


def run_sweep(adapter: IshikiBenchmarkAdapter, args: argparse.Namespace) -> int:
    if args.k < 1:
        raise ValueError("--k must be positive")
    adapter.preflight()
    from harness2.core.proposer import Proposer

    audit = adapter.runs_root / "_audit"
    proposer = Proposer(adapter.spec.channels["proposer"], audit_dir=audit)
    report = schedule.run_sweep(
        args.k,
        adapter=adapter,
        prop=proposer,
        runs_root=adapter.runs_root,
        library_root=adapter.runs_root / "library",
        split=args.split,
        max_tasks=args.max_tasks,
        modes=("agg", "seq"),
        pool_policy="finals",
    )
    output = adapter.runs_root / "sweep.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    print(output)
    return 0


def _main(args: argparse.Namespace) -> int:
    adapter = make_adapter(args)
    if args.list:
        print("\n".join(adapter.tasks(args.split)))
        return 0
    if args.validate is not None:
        tree = {rel.replace(os.sep, "/"): content for rel, content in read_tree(adapter.substrate.surface(), args.validate).items()}
        adapter.validate_tree(tree)
        print(json.dumps({"valid": True, "files": len(tree)}, indent=2))
        return 0
    if args.task is not None:
        harness = args.harness if args.harness is not None else None
        run_dir = adapter.execute(args.task, harness, args.run_id, timeout=args.timeout)
        print(run_dir)
        return 0
    if args.trajectory is not None:
        print(adapter.trajectory(args.trajectory, obs_trunc=adapter.spec.obs_trunc))
        return 0
    if args.score is not None:
        if args.score_task is None:
            raise ValueError("--score-task is required with --score")
        print(json.dumps(adapter.score(args.score, args.score_task), ensure_ascii=False, indent=2))
        return 0
    if args.sweep_dry_run:
        return run_sweep_preview(adapter, args.split, args.max_tasks)
    if args.sweep:
        return run_sweep(adapter, args)
    parser().print_help()
    return 2


def main() -> int:
    try:
        return _main(parser().parse_args())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
