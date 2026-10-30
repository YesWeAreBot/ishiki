# Shell Runtime

just-bash provides a POSIX-style command set, not a Linux host. Shell state does not persist between calls, and each call runs under the configured timeout.

## Files and processes

- Use `/home/workspace` for writable files.
- `/home` and `/home/skills` are read-only mounts.
- Start a process and consume its output in the same call. Background processes do not outlive the call.
- Use `bash` pipelines for listing, searching, text transforms, and archive work that the JavaScript filesystem bridge does not expose.

## SQLite

The `sqlite3` command is available:

```bash
sqlite3 /home/workspace/data.db "CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('hello');"
sqlite3 /home/workspace/data.db "SELECT body FROM notes;"
```

The command does not support dot commands such as `.tables` or `.version`. Pass SQL as the command argument. Python's `sqlite3` module is unavailable, so use this command-line tool for database work.

## Network

When networking is enabled, `curl` and JavaScript `fetch` can reach public addresses. Private and loopback addresses are rejected. Check the task's configured network access before choosing a remote API.
