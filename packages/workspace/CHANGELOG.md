# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Workspace tool pack for ishiki: a sandbox backed by host directories, file tools, and a skills directory.
- Resource center bridged into the sandbox through a virtual filesystem and resource schemes.
- Truncated tool output spills into artifacts (shared with the mcp-client pack).
- Native shell backend for the sandbox.

### Changed
- `workspace:///<absolute path>` reads the shell's actual filesystem, including virtual, persistent, and mounted files; native paths use the native shell's host view.
- Skill and workspace schemes share `FileScheme` for binary reads, metadata, ranges, and lossless continuation instead of separate text-only readers.
- Skill reads check resolved symlink targets against their skill root.
- Track the host extension mechanism: the `ExtensionInstance` surface, then the `AgentPlugin` subset with `provide` moved under `agent.use`, and finally extension packs as Koishi services assembled inside the profile fiber.
- Extension schema and attachment config surfaces refactored toward the host's unified attachment pipeline.
- Truncation handling moved into the ishiki unified attachment pipeline; the sandbox keeps no private spill path.
- Resource filesystem and schemes refactored onto the resource center's single store with core-owned schemes and query views.
- `workspace:///<absolute path>` reads the shell's actual filesystem, including virtual, persistent, and mounted files; native paths use the native shell's host view
- Skill and workspace schemes share `FileScheme` for binary reads, metadata, ranges, and lossless continuation instead of separate text-only readers
- Skill reads check resolved symlink targets against their skill root