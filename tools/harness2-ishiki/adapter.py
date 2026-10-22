from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from harness2.core.spec import BenchPrompts, BenchSpec, ChannelSpec
from harness2.core.tree import read_tree, validate
from harness2.substrate.base import Install, RunRequest

from substrate import IshikiSubstrate


class IshikiBenchmarkAdapter:
    def __init__(self, root: Path | None = None, runs_root: Path | None = None):
        self.root = (root or Path(__file__).resolve().parent).resolve()
        self.scenarios_root = self.root / "scenarios"
        self.runs_root = (runs_root or self.root / "runs").resolve()
        self.runner = self.root / "runner.ts"
        self.substrate = IshikiSubstrate(self.runner, launcher=self._launch)
        proposer_model = os.environ.get("HARNESS2_IMPROVER_MODEL", "")
        channel = ChannelSpec(kind="opencode", model=proposer_model, effort="high", steps=120, timeout=3600)
        self.spec = BenchSpec(
            name="ishiki-scenarios",
            runs_root=self.runs_root,
            install_mode="workspace_config",
            prompts=BenchPrompts(
                work="Improve a long-running Ishiki chat agent's ability to decide when to speak and what exact reply to send.",
                domain_word="scenario family",
                inv_levers="persona wording, persistent instructions, wakeup configuration, and reusable skills",
                dom_levers="the conversation boundary and exact response behavior required by the scenario",
                yardstick="the scenario's observable response count and response text",
                deliverable_word="the Ishiki harness tree",
                domain_guidance="Keep the persistent prompt short and make every skill reachable from it.",
                selection_checks="preserve the profile contract and the scenario's social boundary",
                selection_lead="Prefer a candidate that improves the required behavior without weakening silence behavior.",
            ),
            channels={"proposer": channel, "selector": channel},
            domain_word="scenario family",
            allow_subagents=False,
            proposer_deliverables="contents",
            state_deliverable=True,
            obs_trunc=50_000,
        )

    def preflight(self) -> None:
        self.substrate.preflight()
        if not (os.environ.get("ISHIKI_API_KEY") or os.environ.get("OPENAI_API_KEY")):
            raise RuntimeError("ISHIKI_API_KEY or OPENAI_API_KEY is required for Ishiki executor rollouts")
        proposer_model = self.spec.channels["proposer"].model
        if not proposer_model:
            raise RuntimeError("HARNESS2_IMPROVER_MODEL is required for OpenCode proposer sessions")
        if "/" not in proposer_model:
            raise RuntimeError("HARNESS2_IMPROVER_MODEL must use OpenCode provider/model syntax")
        from harness2 import config

        if not (config.OPENCODE_DIR / "packages" / "opencode" / "src" / "index.ts").is_file():
            raise RuntimeError(
                f"OpenCode checkout missing at {config.OPENCODE_DIR}; run harness2-setup jb"
            )
        if not config.BUN.is_file():
            raise RuntimeError(f"Harness2 Bun runtime missing at {config.BUN}; run harness2-setup jb")

    def tasks(self, split: str = "all") -> list[str]:
        tasks = sorted(path.name for path in self.scenarios_root.iterdir() if (path / "scenario.json").is_file())
        if split in ("all", "train"):
            return tasks
        if split == "test":
            return [task for task in tasks if task == "private-response"]
        raise ValueError(f"unknown split {split!r}; expected all, train, or test")

    def _scenario(self, task_id: str) -> dict[str, Any]:
        if task_id not in self.tasks():
            raise ValueError(f"unknown Ishiki scenario {task_id!r}")
        path = self.scenarios_root / task_id / "scenario.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError(f"scenario {task_id!r} must be a JSON object")
        return value

    def domain_of(self, task_id: str) -> str:
        return str(self._scenario(task_id)["domain"])

    def reference_domain_order(self) -> list[str]:
        return sorted({self.domain_of(task) for task in self.tasks()})

    def task_prompt(self, task_id: str) -> str:
        return str(self._scenario(task_id)["prompt"])

    def task_files(self, task_id: str) -> Path | None:
        directory = self.scenarios_root / task_id
        return directory if directory.is_dir() else None

    def base_harness(self) -> Path:
        base = self.root / "base"
        if not base.is_dir():
            raise FileNotFoundError(f"Ishiki base harness missing: {base}")
        return base

    def validate_tree(self, tree: dict[str, str]) -> None:
        validate(self.substrate.surface(), tree, allow_subagents=False)
        required = ("profile.yml", "persona.md", "prompts/instructions.md")
        missing = [path for path in required if not tree.get(path, "").strip()]
        if missing:
            raise ValueError(f"Ishiki harness requires non-empty files: {missing}")
        unsupported = sorted(path for path in tree if path.startswith("scripts/") or "/scripts/" in path)
        if unsupported:
            raise ValueError(f"Ishiki headless runner does not expose scripts: {unsupported}")

    def execute(
        self, task_id: str, harness_dir: Path | None, run_id: str, *, timeout: int | None = None
    ) -> Path:
        source = Path(harness_dir) if harness_dir is not None else self.base_harness()
        install = self.substrate.materialise(source, self.spec, {})
        try:
            run_dir = self._run_dir(task_id, run_id)
            marker = run_dir / "run.json"
            if self.delivered(run_dir) and marker.is_file():
                saved = json.loads(marker.read_text(encoding="utf-8"))
                if saved.get("harness_fingerprint") == install.fingerprint:
                    return run_dir
            shutil.rmtree(run_dir, ignore_errors=True)
            result = self.substrate.execute(task_id, install, [run_id], int(timeout or 300))
            if len(result) != 1:
                raise RuntimeError(f"Ishiki runner returned {len(result)} directories for one run")
            return result[0]
        finally:
            shutil.rmtree(install.staging_dir, ignore_errors=True)

    def _run_dir(self, task_id: str, run_id: str) -> Path:
        safe = run_id.replace("/", "__").replace("\\", "__").replace(":", "_")
        if not safe or safe in (".", ".."):
            raise ValueError(f"invalid run id {run_id!r}")
        return self.runs_root / task_id / safe

    def _launch(self, request: RunRequest, install: Install) -> list[Path]:
        self.substrate.preflight()
        output: list[Path] = []
        for run_id in request.run_ids:
            run_dir = self._run_dir(request.task_ref, run_id)
            run_dir.mkdir(parents=True, exist_ok=True)
            command = [
                "bun",
                str(self.runner),
                "--scenario",
                request.task_ref,
                "--harness",
                str(install.staging_dir),
                "--run-dir",
                str(run_dir),
                "--timeout-ms",
                str(max(1, request.timeout) * 1000),
            ]
            try:
                completed = subprocess.run(
                    command,
                    cwd=self.root.parents[1],
                    env=os.environ.copy(),
                    capture_output=True,
                    text=True,
                    timeout=max(1, request.timeout) + 30,
                    check=False,
                )
            except subprocess.TimeoutExpired as error:
                raise RuntimeError(f"Ishiki runner timed out for {request.task_ref}/{run_id}") from error
            if completed.returncode != 0:
                detail = (completed.stderr or completed.stdout).strip()[-2000:]
                raise RuntimeError(f"Ishiki runner failed for {request.task_ref}/{run_id}: {detail}")
            marker = run_dir / "run.json"
            if not marker.is_file():
                raise RuntimeError(f"Ishiki runner produced no run.json: {run_dir}")
            marker_data = json.loads(marker.read_text(encoding="utf-8"))
            marker_data["harness_fingerprint"] = install.fingerprint
            marker.write_text(json.dumps(marker_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            output.append(run_dir)
        return output

    def delivered(self, run_dir: Path) -> bool:
        if not Path(run_dir).is_dir():
            return False
        marker = Path(run_dir) / "run.json"
        if not marker.is_file():
            return False
        try:
            return json.loads(marker.read_text(encoding="utf-8")).get("status") == "completed"
        except json.JSONDecodeError:
            return False

    def trajectory(self, run_dir: Path, *, obs_trunc: int) -> str:
        return self.substrate.read_trajectory(Path(run_dir) / "events.jsonl", obs_trunc=obs_trunc, max_chars=8_000_000)

    def deliverable_files(self, run_dir: Path) -> dict[str, str]:
        path = Path(run_dir) / "response.txt"
        return {path.name: path.read_text(encoding="utf-8", errors="replace")} if path.is_file() else {}

    def deliverable_text(self, run_dir: Path) -> str:
        files = self.deliverable_files(run_dir)
        return files.get("response.txt", "")

    def score(self, run_dir: Path, task_id: str) -> dict[str, Any] | None:
        if not self.delivered(run_dir):
            return None
        scenario = self._scenario(task_id)
        expected = scenario.get("expected", {})
        replies = json.loads((Path(run_dir) / "run.json").read_text(encoding="utf-8")).get("replies", [])
        reply_count = len(replies) if isinstance(replies, list) else -1
        passed = reply_count == int(expected.get("replyCount", -1))
        contains = expected.get("contains")
        if contains is not None:
            passed = passed and str(contains) in self.deliverable_text(run_dir)
        return {
            "n_passed": int(passed),
            "n_criteria": 1,
            "all_pass": passed,
            "metric": "scenario-exact-response",
            "reply_count": reply_count,
            "expected_reply_count": expected.get("replyCount"),
        }


__all__ = ["IshikiBenchmarkAdapter"]
