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

- Workspace prompt, skills wrapper, and tool descriptions are English, improving tool-search tokenization and matching.
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
- Sandbox prompts describe workspace read URLs and the WebAssembly python runtime when available
- Workspace instructions and tool descriptions are inline Jinja templates rendered with the engine exported by the core runtime.
- Workspace instructions and tool descriptions are inline Jinja templates rendered with the engine exported by the core runtime
- Native tools resolve `/tmp` by asking the shell where it points, instead of assuming the host's `os.tmpdir()`; prompts and tool descriptions keep scratch files inside the working directory, because the shell, a program the shell starts, and the file tools can each resolve `/tmp` to a different folder.
- Workspace prompts and tool descriptions direct scratch files to `./tmp` under the working directory, because the shell, host programs, and file tools can resolve `/tmp` to different folders

### Fixed

- Native file tools resolve the git-bash path `/tmp` to the folder the shell itself reports, so tool paths and shell commands name the same file instead of `D:\tmp`.
- Workspace tool descriptions state which path spellings the shell converts and that drive paths inside values handed to another program must be written `D:/...`.
