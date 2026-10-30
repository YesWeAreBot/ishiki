# Python Runtime

`python3` and `python` run CPython 3.13 through Emscripten. The first call waits for the runtime to load. Scripts read and write the same sandbox paths as the shell.

## Available modules

Most pure-Python standard library modules are available. Native integration is limited:

- `subprocess` is unavailable.
- `_sqlite3` and the `sqlite3` module are unavailable.
- Third-party packages cannot be installed.
- Long-running threads, sockets, and process management are unavailable.

Use `/home/workspace` for scripts and generated files. For SQLite work, use the shell's `sqlite3` command. To start Python from JavaScript, use `node:child_process`; Python cannot start shell commands or other programs.
