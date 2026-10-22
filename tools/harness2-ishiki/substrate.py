from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable, Mapping

from harness2.core.tree import SurfaceSpec, read_tree, validate, write_tree
from harness2.substrate.base import Install, RunRequest


class IshikiSubstrate:
    name = "ishiki"

    def __init__(self, runner: Path, launcher: Callable[[RunRequest, Install], list[Path]] | None = None):
        self.runner = runner.resolve()
        self.launcher = launcher

    def surface(self) -> SurfaceSpec:
        return SurfaceSpec(
            name=self.name,
            always_on=("profile.yml", "persona.md", "prompts/instructions.md"),
            always_on_max=24_000,
            always_on_cap_reason="Ishiki sends these files on every runtime start; keep the persistent prompt compact.",
            skill_dir="skills",
            skill_name_rule="must_match",
            trigger_hint="Add a trigger sentence naming `{name}` to prompts/instructions.md.",
            autotrigger_file="prompts/instructions.md",
            trigger_line="When the {name} skill applies, read and follow skills/{name}/SKILL.md.",
            subagent_requires_mode=True,
            plugin_dir=None,
            hooks_file=None,
            compile_skill_scripts=True,
            reject_empty_always_on=True,
        )

    def materialise(self, tree_dir: Path, spec, ctx: Mapping[str, str]) -> Install:
        rejected: list[str] = []
        raw_tree = read_tree(self.surface(), tree_dir, rejected=rejected)
        tree = {rel.replace(os.sep, "/"): content for rel, content in raw_tree.items()}
        if rejected:
            rejected = [rel.replace(os.sep, "/") for rel in rejected]
            raise ValueError(f"Ishiki harness contains files outside its editable surface: {rejected}")
        validate(self.surface(), tree, allow_subagents=False)
        for rel in tree:
            if rel == "scripts" or rel.startswith("scripts/") or "/scripts/" in rel:
                raise ValueError(f"Ishiki headless runner does not expose scripts: {rel}")
        fingerprint = hashlib.sha256(
            json.dumps(sorted(tree.items()), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        staging = Path(tempfile.mkdtemp(prefix="ishiki-harness-"))
        write_tree(self.surface(), tree, staging)
        return Install(staging_dir=staging, fingerprint=fingerprint, extras={"runner": str(self.runner)})

    def execute(self, task_ref: str, install: Install, run_ids: list[str], timeout: int) -> list[Path]:
        if self.launcher is None:
            raise RuntimeError("IshikiSubstrate has no benchmark launcher")
        request = RunRequest(task_ref=task_ref, run_ids=tuple(run_ids), timeout=int(timeout))
        return self.launcher(request, install)

    def read_trajectory(
        self, stream_path: Path, *, obs_trunc: int, max_chars: int, args_trunc: int = 400
    ) -> str:
        if not stream_path.is_file():
            return f"(no trajectory: {stream_path})"
        lines: list[str] = []
        for raw in stream_path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                entry = json.loads(raw)
            except json.JSONDecodeError:
                lines.append(f"[ERROR] {raw[:args_trunc]}")
                continue
            rendered = self._render_entry(entry, obs_trunc)
            if rendered:
                lines.append(rendered)
        result = "\n".join(lines)
        return result[:max_chars]

    @staticmethod
    def _render_entry(entry: object, obs_trunc: int) -> str:
        if not isinstance(entry, dict):
            return f"[OBSERVATION] {str(entry)[:obs_trunc]}"
        kind = entry.get("type")
        data = entry.get("data")
        if kind == "event" and isinstance(data, dict):
            event_type = str(data.get("type", "event"))
            return f"[OBSERVATION] {event_type}"
        if kind != "message" or not isinstance(data, dict):
            return f"[OBSERVATION] {json.dumps(entry, ensure_ascii=False)[:obs_trunc]}"
        role = data.get("role")
        if role == "custom":
            custom_type = data.get("type")
            payload = data.get("data")
            if custom_type == "ishiki.message.created" and isinstance(payload, dict):
                return f"[OBSERVATION] inbound {payload.get('content', '')}"[: obs_trunc + 25]
            return f"[OBSERVATION] custom {custom_type}: {json.dumps(payload, ensure_ascii=False)[:obs_trunc]}"
        content = data.get("content")
        if isinstance(content, list):
            content = json.dumps(content, ensure_ascii=False)
        return f"[OBSERVATION] {role}: {str(content)[:obs_trunc]}"

    def preflight(self) -> None:
        if not self.runner.is_file():
            raise FileNotFoundError(f"Ishiki runner missing: {self.runner}")
        if shutil.which("bun") is None:
            raise RuntimeError("Bun is required to run the Ishiki headless adapter")


__all__ = ["IshikiSubstrate"]
