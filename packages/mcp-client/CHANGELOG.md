# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Raised the `koishi-plugin-ishiki` peer dependency range to `>=0.0.2 <0.1.0`
## [0.0.2] - 2026-10-26

### Changed
- Package metadata now carries a description, keywords, repository, homepage, and bug tracker, and declares `ishiki` as a required service for the Koishi market
- The `koishi-plugin-ishiki` peer dependency now accepts any `0.0.x` release instead of only `0.0.1`

## [0.0.1] - 2026-10-25

### Added
- `toolIndex` per server: connected servers list their exposed tool names in the system prompt, even when the server provides no instructions.
- `prefix` per server: exposed tool names use the server name by default, drop it with `false`, or use a custom string prefix.
- `deny` per server: excludes tools by the raw names exposed by the MCP server.
- MCP server tools integrated into ishiki, with configuration validated by `mcp.schema.json` and an example at `resources/mcp.example.json`.
- MCP tools and instructions labeled by their server of origin.
- Truncated tool output spills into artifacts (shared with koishi-plugin-ishiki-workspace).
- MCP resources registered into the ishiki resource center, with server media outputs converted into media assets.
- `prefix` per server: exposed tool names use the server name by default, drop it with `false`, or use a custom string prefix
- `deny` per server: excludes tools by the raw names exposed by the MCP server

### Changed
- Resource handlers receive the complete URL and forward nested resource URIs, queries, and fragments unchanged; remote media is marked live for model-exit snapshotting.
- Tool output schemas describe the native MCP content blocks returned inside codemode; model conversion and resource processing remain outside internal tool calls.
- Track the host extension mechanism: the `ExtensionInstance` surface, then the `AgentPlugin` subset with `provide` moved under `agent.use`, and finally extension packs as Koishi services assembled inside the profile fiber.
- Tool output and attachment handling unified into the ishiki runtime attachment pipeline.
- Resource access relies on the resource center's single store with core-owned schemes and query views.
- Resource handlers receive the complete URL and forward nested resource URIs, queries, and fragments unchanged; remote media is marked live for model-exit snapshotting
- Tool output schemas describe the native MCP content blocks returned inside codemode; model conversion and resource processing remain outside internal tool calls
- Server summaries combine declared instructions with the exposed tool-name index
- Duplicate exposed tool names across servers now raise a `ToolConflictError` instead of silently overwriting earlier tools

[Unreleased]: https://github.com/YesWeAreBot/ishiki/compare/koishi-plugin-ishiki-mcp-client@0.0.2...HEAD
[0.0.2]: https://github.com/YesWeAreBot/ishiki/releases/tag/koishi-plugin-ishiki-mcp-client@0.0.2
