# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.5] - 2026-10-31

### Breaking Changes

- The extension invoke hook now receives `ExtensionHost` before the config

### Added

- Added a bundled `sandbox-environment` skill that routes work across just-bash, QuickJS, WebAssembly Python, SQLite, networking, and sandbox files, with detailed runtime references loaded only when needed

### Changed

- The sandbox prompt now names just-bash, describes the partial Node.js module surface and missing Python modules, and points to the environment skill for runtime-specific details
- Sandbox prompts now warn that `/tmp` only lives for the current sandbox lifetime and that files worth keeping belong in the workspace or an artifact

### Fixed

- The JavaScript `fs` bootstrap now provides `constants`, `Stats` and `Dirent` instances, `accessSync`, file URL path arguments, `COPYFILE_EXCL`, and `Buffer` results from `readFileBuffer`
- Sandbox commands now pass the configured timeout to just-bash's overall, JavaScript, Python, and SQLite limits, so `js-exec` no longer stops at its built-in 30-second limit
- Sandbox `bash` now returns error output when the exit code is non-zero, so failures are not mistaken for success

## [0.0.4] - 2026-10-30

### Added

- Added a Node-compatible `fs` bootstrap to the JavaScript sandbox so guest code gets `Stats`, `Dirent`, `readdir` options, and error codes instead of the flattened bridge shapes

## [0.0.3] - 2026-10-29

### Changed

- Raised the `koishi-plugin-ishiki` peer dependency range to `>=0.0.2 <0.1.0`

## [0.0.2] - 2026-10-26

### Changed

- Package metadata now carries a description, keywords, repository, homepage, and bug tracker, and declares `ishiki` as a required service for the Koishi market
- The `koishi-plugin-ishiki` peer dependency now accepts any `0.0.x` release instead of only `0.0.1`

## [0.0.1] - 2026-10-25

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
- Development depends on `koishi-plugin-ishiki` through `workspace:^`

### Fixed

- Native file tools resolve the git-bash path `/tmp` to the folder the shell itself reports, so tool paths and shell commands name the same file instead of `D:\tmp`.
- Workspace tool descriptions state which path spellings the shell converts and that drive paths inside values handed to another program must be written `D:/...`.

[Unreleased]: https://github.com/YesWeAreBot/ishiki/compare/koishi-plugin-ishiki-workspace@0.0.5...HEAD
[0.0.5]: https://github.com/YesWeAreBot/ishiki/compare/koishi-plugin-ishiki-workspace@0.0.4...koishi-plugin-ishiki-workspace@0.0.5
[0.0.4]: https://github.com/YesWeAreBot/ishiki/compare/koishi-plugin-ishiki-workspace@0.0.3...koishi-plugin-ishiki-workspace@0.0.4
[0.0.3]: https://github.com/YesWeAreBot/ishiki/compare/koishi-plugin-ishiki-workspace@0.0.2...koishi-plugin-ishiki-workspace@0.0.3
[0.0.2]: https://github.com/YesWeAreBot/ishiki/compare/koishi-plugin-ishiki-workspace@0.0.1...koishi-plugin-ishiki-workspace@0.0.2
[0.0.1]: https://github.com/YesWeAreBot/ishiki/releases/tag/koishi-plugin-ishiki-workspace@0.0.1
