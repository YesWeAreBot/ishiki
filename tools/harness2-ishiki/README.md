# Harness2 Ishiki Adapter

This runner reuses Ishiki's production `renderInstructions()` output, including the built-in wakeup, tool, `send_message`, `wait`, attachment, and persona rules. The harness candidate then adds `persona.md`, `prompts/instructions.md`, and skills through the same `AgentPlugin` extension path used by runtime assembly. It does not replace the production system prompt with a test-only instruction.

## Check the integration

From the Ishiki repository:

```powershell
uv run --project D:/Codespace/references/harness2 python tools/harness2-ishiki/run_harness.py --list
uv run --project D:/Codespace/references/harness2 python tools/harness2-ishiki/run_harness.py --validate tools/harness2-ishiki/base
uv run --project D:/Codespace/references/harness2 python tools/harness2-ishiki/run_harness.py --sweep-dry-run
```

`--sweep-dry-run` uses Harness2's task-stream scheduling without starting a model or writing rollout data.

## Run a scenario

The checked-in base profile uses `openai:ishiki` as an explicit placeholder. Set `ISHIKI_MODEL` for that profile or replace its `model:` value with the model ID accepted by the endpoint.

```powershell
$env:ISHIKI_API_KEY = "..."
$env:ISHIKI_MODEL = "your-model-id"
$env:ISHIKI_BASE_URL = "https://api.openai.com/v1"
uv run --project D:/Codespace/references/harness2 python tools/harness2-ishiki/run_harness.py --run group-mention --run-id manual-1 --timeout 300
```

The run directory contains `run.json`, `response.txt`, and `events.jsonl`. Inspect it with:

```powershell
uv run --project D:/Codespace/references/harness2 python tools/harness2-ishiki/run_harness.py --score tools/harness2-ishiki/runs/group-mention/manual-1 --score-task group-mention
uv run --project D:/Codespace/references/harness2 python tools/harness2-ishiki/run_harness.py --trajectory tools/harness2-ishiki/runs/group-mention/manual-1
```

The base harness includes three scenarios:

- `group-silence`: an unaddressed group message must produce no reply.
- `group-mention`: an addressed group message must send `ACK`.
- `private-response`: a direct message must send `PRIVATE-ACK`.

The first scenario does not create a model request when it remains silent, so it can run without credentials. The two response scenarios require a reachable model endpoint.

## Configure a full sweep

The sweep has two independent model paths:

- Ishiki execution uses the model in the staged `profile.yml` and needs `ISHIKI_API_KEY` or `OPENAI_API_KEY`, plus `ISHIKI_BASE_URL` when the endpoint is not OpenAI.
- Harness2 proposal and composition uses OpenCode. Set `HARNESS2_IMPROVER_MODEL` in `provider/model` form, and configure the credentials required by that provider. The custom adapter uses this as its proposer model; the standard Harness2 `HARNESS2_SOLVER_MODEL` setting is not used by this adapter.

From the Harness2 checkout, install the pinned OpenCode/Bun dependencies once:

```powershell
uv pip install -e D:/Codespace/references/harness2
uv run --project D:/Codespace/references/harness2 python -m harness2.cli.setup jb
```

The setup command installs OpenCode for the selected Harness2 benchmark and may install that benchmark's own data and dependencies. For this custom Ishiki adapter, only the OpenCode installation is used. For Vertex models, configure `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and Application Default Credentials as described in Harness2 `docs/SETUP.md`. For a compatible non-Vertex provider, configure the provider's OpenCode credentials instead.

Before spending on a sweep, run the dry preview and then a single model-backed scenario. A sweep is meaningful only after both paths have succeeded:

```powershell
$env:HARNESS2_IMPROVER_MODEL = "google-vertex/gemini-..."
$env:ISHIKI_API_KEY = "..."
$env:ISHIKI_MODEL = "your-model-id"
uv run --project D:/Codespace/references/harness2 python tools/harness2-ishiki/run_harness.py --sweep-dry-run
uv run --project D:/Codespace/references/harness2 python tools/harness2-ishiki/run_harness.py --run group-mention --run-id model-check --timeout 300
uv run --project D:/Codespace/references/harness2 python tools/harness2-ishiki/run_harness.py --sweep --k 1 --max-tasks 1
```

`--sweep` currently exercises Harness2's proposer/composer against this custom benchmark adapter. It does not make the three scenarios equivalent to a broad production evaluation.

## Measurement limits

The current scenarios are a smoke benchmark, not a comprehensive Ishiki evaluation. They measure wakeup precision for one unaddressed group message, one addressed group reply, and one private reply. They do not measure multi-turn memory, context compaction, `wait` scheduling, cross-channel routing, tool failures, attachments, codemode, toolsearch, extensions, rate limits, latency, cost, or persona quality beyond exact response text.

Their useful result is a regression signal for prompt and wakeup changes: reply count, exact response content, stored event trajectory, and whether a candidate preserves silence. They cannot establish general conversational quality or prove that an optimization improves real deployments. A serious benchmark should add paired positive/negative wakeup cases, multi-turn memory and compaction cases, wait/reawaken cases, cross-channel target cases, tool and attachment cases, and robustness variants with paraphrased inputs.

## Editable surface

Harness2 candidates may edit `profile.yml`, `persona.md`, `prompts/instructions.md`, and `skills/<name>/SKILL.md`. Skill names must match their directory names and must be named from persistent instructions. Subagents, plugins, hooks, and scripts are rejected because this headless runner does not expose those Ishiki capabilities.

The headless runner accepts channel profiles with the standard context and wakeup engines, native tool calls, text-only input, no codemode, and no profile extensions. It rejects other profile modes instead of silently measuring a different runtime.
