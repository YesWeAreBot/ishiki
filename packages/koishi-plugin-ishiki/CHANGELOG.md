# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

- Merge attachment capture, model-output processing, and request projection into resources; the runtime owns message submission and context rendering order.
- Resource handlers receive complete URLs. File-backed schemes share `FileScheme`; `read` returns structured text or base64 media, and codemode declares final media through `attachments`.
- Ordinary oversized results become artifact snapshots; file pages continue at their source with lossless offsets, including Unicode and long single lines. Existing SDK execution limits remain unchanged.
- Extension packs are now Koishi services assembled inside the profile fiber.
- The extension face converged onto `ctx.ishiki.provide()` with `ExtensionInstance` packs, `provide` moved under `agent.use`, and engine variants isolated as their own services with a callable provider.
- Profile model flattened: the preset layer is gone; one `profile.yaml` is one profile.
- Resource storage refactored into one store with core-owned schemes and query views.
- jev wakeup verdicts are synthesized from three questions; fact-line addressing headers no longer name the sender.
- Turn-stop verdicts concentrate into the single plugin implementation, and code-mode wiring got corrected in the process.
- Dependency pins: `@yesimagent/core` and `@yesimagent/gateway` at 0.0.8, `@ai-sdk/code-mode` at 1.0.94 with `@ai-sdk-tool/parser` at 5.1.6.
- Wakeup engines subscribe to committed messages and schedule their own wakes; `decide` and `WakeupDecision` are gone
- Dependency pins: `@yesimagent/core` and `@yesimagent/gateway` at 0.0.9, `@ai-sdk/code-mode` at 1.0.94 with `@ai-sdk-tool/parser` at 5.1.6
- Merge attachment capture, model-output processing, and request projection into resources; the runtime owns message submission and context rendering order
- Resource handlers receive complete URLs. File-backed schemes share `FileScheme`; `read` returns structured text or base64 media, and codemode declares final media through `attachments`
- Ordinary oversized results become artifact snapshots; file pages continue at their source with lossless offsets, including Unicode and long single lines. Existing SDK execution limits remain unchanged
- Search matches return a name and a short hint; the next catalog update carries their full signatures
- Codemode and toolsearch prompt sections explain catalog updates and when to re-inspect attachments

### Removed

- The narrative context and tool-calling engines now ship as the separate `koishi-plugin-ishiki-narrative` plugin; core keeps only the engine families and their base types.
- The standalone attachment module, central `ResourceUrl` parser, `resolveView` / `opaque` / `locate` handler hooks, and the singular `attachment` result field; no compatibility aliases or data migration.
- `think` tool, succeeded by `inner_thoughts`.
- Cross-scene delivery tool, replaced by the aggregated cross-channel windows.
- The standalone attachment module, central `ResourceUrl` parser, `resolveView` / `opaque` / `locate` handler hooks, and the singular `attachment` result field; no compatibility aliases or data migration
- The narrative context and tool-calling engines now ship as the separate `koishi-plugin-ishiki-narrative` plugin; core keeps only the engine families and their base types

### Fixed

- Platform attachments preserve document order when asynchronous registrations complete out of order.
- Live media references are snapshotted before attachment submission, and unresolved declared media reports its read error without a fabricated reference.
- Context budgets use token-based accounting and are recalculated at turn end, with trimming applied to whole turns.
- Compressed history is demoted to supplementary material, with instructions kept in their own system prompt.
- Attachment extraction requires a payload or URL up front.
- The first request carries the baseline tool catalog instead of an empty one.
- Platform attachments preserve document order when asynchronous registrations complete out of order
- Live media references are snapshotted before attachment submission, and unresolved declared media reports its read error without a fabricated reference
