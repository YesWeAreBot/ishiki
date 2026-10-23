# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Per-profile `pacing` step budget: `maxSteps` caps one waking (default 20), `wrapUpSteps` (default 2) reminds the model before the cap so the last step sends something, and `progressAt` (default 8) asks once for a mid-task progress bubble. Both reminders ride only the affected request and never enter the stored transcript; `0` disables either one.
- Image lifetimes for attachments: `once` (default; consumed only when the image-bearing response is persisted), `recent` (keep the latest viewed images, pruned in batches), and `retain` (stay eligible while the source record remains in context). `attachment.recentImageCount` (default 3) and `attachment.imagePruneBatchSize` (default 2) control pruning; final codemode `attachments[]` items and direct `read` calls under `imageInput` can override the lifetime.
- Incremental tool catalogs with `catalogMode`, `fullSnapshotEvery`, and `knownIndex`; incremental updates send only new, changed, or removed tools, with catalog-version recovery after context compaction.
- Shared output-type aliases in catalogs, so repeated MCP return shapes are declared once.
- `wait` tool for agent-declared wake conditions.
- Unified attachment pipeline in the runtime: tool outputs and inbound media flow through one attachment path.
- Built-in tool search with deferred tool loading.
- Resource center core for one-stop resources, with a unified `read` tool on top and an inbound media registration pipeline.
- Extended outbound sending, with MCP resources and media registered as assets in the resource center.
- `debugStream` to print model stream chunks verbatim to the console.
- Cross-channel aggregated windows together with the community engine.
- Per-scene agents with context partitioning per scene.
- Tool-calling engines: JSON OUTPUT with cross-scene footprints, plus hermes, morph-xml, qwen3coder, yaml-xml, and thoughts variants; the classic trio of context / tool / wakeup engines (later renamed v3); the jev wakeup engine with async wakeup verdict round-trips.
- Thinking via `inner_thoughts`, with a degradation retry on failed model calls.
- Workspace context budgeting driven from the profile (`workspaceTokenLimit`, `charsPerToken`).
- Initial plugin surface: profile configuration with validation and channel rules, scene management with frame rendering, session handlers for message creation and deletion, focus switching, notifications, self message events, and typing delay configuration.
- `Template` from `@huggingface/jinja` is re-exported by the plugin, so extensions render prompts with the same Jinja engine
- Agent overlay plugin that overrides system instructions and tool descriptions from files inside a profile root
- Public service lifecycle methods for profiles and runtimes: `activate`, `deactivate`, `restart`, `ensureRuntime`, `deliver`, and `wake`
- `externalPlugins` runtime option that mounts external `AgentPlugin`s and applies name-preserving `transformTools` stages before tool catalogs are built
- Image lifetimes for attachments: `once`, `recent`, and `retain`, with `attachment.recentImageCount` and `attachment.imagePruneBatchSize` controlling batch pruning
- Ishiki console prototype under `client/`: models, profile, session, runtime, usage, audit, cache, and cost pages driven by in-memory sample data, with `console:build` and `console:dev` scripts

### Changed
- The `v3` context, toolcall and wakeup engines moved to the separate `koishi-plugin-ishiki-engine-v3` plugin, together with their JSON parser and Jinja templates. Enable that plugin to keep using `engine: v3`.
- Request projection tracks image delivery per item: `once` commits only when the image-bearing response is persisted (the ledger entry is appended with that response), `recent` keeps the latest viewed images and prunes the oldest viewed in batches, `retain` stays eligible while its source record survives, and failed or aborted steps do not consume. Terminal rejections are stated once, and projected message prefixes keep their order, IDs and timestamps until selection or pruning changes.
- Merge attachment capture, model-output processing, and request projection into resources; the runtime owns message submission and context rendering order.
- Resource handlers receive complete URLs. File-backed schemes share `FileScheme`; `read` returns structured text or base64 media, and codemode declares final media through `attachments`.
- Ordinary oversized results become artifact snapshots; file pages continue at their source with lossless offsets, including Unicode and long single lines. Existing SDK execution limits remain unchanged.
- Extension packs are now Koishi services assembled inside the profile fiber.
- The extension face converged onto `ctx.ishiki.provide()` with `ExtensionInstance` packs, `provide` moved under `agent.use`, and engine variants isolated as their own services with a callable provider.
- Profile model flattened: the preset layer is gone; one `profile.yaml` is one profile.
- Resource storage refactored into one store with core-owned schemes and query views.
- jev wakeup verdicts are synthesized from three questions; fact-line addressing headers no longer name the sender.
- Turn-stop verdicts concentrate into the single plugin implementation, and code-mode wiring got corrected in the process.
- Wakeup engines subscribe to committed messages and schedule their own wakes; `decide` and `WakeupDecision` are gone
- Dependency pins: `@yesimagent/core` and `@yesimagent/gateway` at 0.0.9, `@earendil-works/pi-codemode` at 1.4.0 with `@ai-sdk-tool/parser` at 5.1.6
- Codemode runs JavaScript programs in a QuickJS worker through `@earendil-works/pi-codemode`. `tools["name"]` calls host tools, `searchTools` / `describeTool` read declarations on demand, `image()` stores images for the attachment pipeline, `store()` / `load()` keep small session state, and results come back in fixed sections. Codemode is enabled by default.
- Discovery queries return matching tool names with a short hint, and `describeTool` renders the full declaration on demand
- The codemode prompt section explains the JavaScript body, discovery globals, explicit text output, images and session state
- Documentation presents Ishiki as a Bot meta-framework for autonomous agents, with the core runtime README rewritten around the three engine families
- Documentation and READMEs adopt the new Ishiki logo, icon, and slogan "意识的运行时，人格的栖息地"
- The system prompt drops the control-flow section and states pacing after the basic functions; the codemode example uses the underscore tool name
- System prompt rendering moved to `renderInstructions()`, which plugin activation and the harness both reuse
- Image delivery is tracked per projected item, so failed or aborted steps do not consume a lifetime and message prefixes keep their order, IDs, and timestamps
- The system prompt states the step budget and the mid-task progress habit after the basic functions, and codemode instructions note the sandbox has no `fetch` or timers
- Profile `instructions` lists files appended to the end of the system prompt in declaration order (relative to the profile root, or absolute). Missing files log a warning without blocking activation, and the default is `[PERSONA.md]`

### Removed
- The `toolsearch` profile section, the standalone `search` tool, `ishiki.tools.catalog` messages, and the incremental catalog state machine. Discovery now lives inside codemode as the `searchTools` and `describeTool` globals, which never change the callable set or the model schema.
- `codemode.maxToolInputBytes`, `codemode.maxToolOutputBytes` and `codemode.maxResultBytes`: the sandbox uses its own output and store limits, and the model preview budget is `codemode.maxOutputTokens`. Profiles that still set them fail activation with an explicit migration error.
- The `@ai-sdk/code-mode` dependency and its `vendor/tool-prompt.ts` description builder; declarations come from `@earendil-works/pi-codemode`.
- `attachment.maxImageRenders`: replaced by image lifetimes (`once`, `recent`, `retain`) and `attachment.recentImageCount` / `attachment.imagePruneBatchSize`. Profiles that still set it fail activation with an explicit migration error.
- The narrative context and tool-calling engines now ship as the separate `koishi-plugin-ishiki-narrative` plugin; core keeps only the engine families and their base types.
- The standalone attachment module, central `ResourceUrl` parser, `resolveView` / `opaque` / `locate` handler hooks, and the singular `attachment` result field; no compatibility aliases or data migration.
- `think` tool, succeeded by `inner_thoughts`.
- Cross-scene delivery tool, replaced by the aggregated cross-channel windows.
- `attachment.maxImageRenders`, replaced by image lifetimes; profiles that still set it fail activation with a migration error

### Fixed
- Assets without a directly downloadable source return `resource_unavailable` with their metadata URL and platform-neutral recovery guidance. HTTP fetch errors retain status or network error codes without exposing source URLs.
- Codemode instructions keep temporary download URLs in local variables across tool calls within one execution and return only the final operation's result.
- Declared `msgs` wake windows count committed inbound input again: the wait machine subscribes to `message.appended` and `turn.start` to arm, count, and fire them.
- Platform attachments preserve document order when asynchronous registrations complete out of order.
- Live media references are snapshotted before attachment submission, and unresolved declared media reports its read error without a fabricated reference.
- Context budgets use token-based accounting and are recalculated at turn end, with trimming applied to whole turns.
- Compressed history is demoted to supplementary material, with instructions kept in their own system prompt.
- Attachment extraction requires a payload or URL up front.
- The first request carries the baseline tool catalog instead of an empty one.