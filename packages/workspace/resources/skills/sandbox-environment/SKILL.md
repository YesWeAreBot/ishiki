---
name: sandbox-environment
description: Use before running or debugging shell commands, JavaScript, TypeScript, Python, SQLite, networking, or file operations in the Ishiki sandbox; it routes work to the supported runtime and records the environment's API gaps.
---

# Sandbox Environment

The workspace is a just-bash environment with optional QuickJS and WebAssembly Python runtimes. Choose the executor before writing runtime-specific code.

## Choose the executor

- Use the POSIX shell for file discovery, text pipelines, archive commands, and the SQLite command-line tool.
- Use `js-exec <file>` for JavaScript or TypeScript. The `node` command is a usage notice, so it does not execute scripts.
- Use `python3` or `python` for Python code. The first invocation waits for the WebAssembly runtime to load.

Read the matching reference before using runtime-specific APIs:

- Shell commands, mounts, SQLite, and networking: [references/shell.md](references/shell.md)
- JavaScript modules, globals, `fs`, and async callbacks: [references/javascript.md](references/javascript.md)
- Python modules, subprocesses, and persistence: [references/python.md](references/python.md)

## Shared paths

- `/home` is read-only and contains this instance's data directory.
- `/home/workspace` is the writable working directory. Put scripts and generated files here.
- `/home/skills` is read-only. Read a skill, then run only scripts that the task needs.

Each shell call is isolated by the configured timeout. Environment variables, functions, aliases, and the current directory return to their defaults on the next call.
