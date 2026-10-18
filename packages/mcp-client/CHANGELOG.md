# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- MCP server tools integrated into ishiki, with configuration validated by `mcp.schema.json` and an example at `resources/mcp.example.json`.
- MCP tools and instructions labeled by their server of origin.
- Truncated tool output spills into artifacts (shared with koishi-plugin-ishiki-workspace).
- MCP resources registered into the ishiki resource center, with server media outputs converted into media assets.

### Changed
- Resource handlers receive the complete URL and forward nested resource URIs, queries, and fragments unchanged; remote media is marked live for model-exit snapshotting.
- Tool output schemas describe the native MCP content blocks returned inside codemode; model conversion and resource processing remain outside internal tool calls.
- Track the host extension mechanism: the `ExtensionInstance` surface, then the `AgentPlugin` subset with `provide` moved under `agent.use`, and finally extension packs as Koishi services assembled inside the profile fiber.
- Tool output and attachment handling unified into the ishiki runtime attachment pipeline.
- Resource access relies on the resource center's single store with core-owned schemes and query views.
- Resource handlers receive the complete URL and forward nested resource URIs, queries, and fragments unchanged; remote media is marked live for model-exit snapshotting
- Tool output schemas describe the native MCP content blocks returned inside codemode; model conversion and resource processing remain outside internal tool calls