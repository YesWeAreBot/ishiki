import { HOME_MOUNT, ISHIKI_MOUNT, SKILLS_MOUNT, WORKSPACE_MOUNT } from "./mounts.js";
import type { WorkspaceShell } from "./shell.js";

export function workspaceInstructions(sandbox: WorkspaceShell): string {
  return sandbox.backend === "native" ? nativeInstructions(sandbox) : sandboxInstructions(sandbox);
}

function nativeInstructions(sandbox: WorkspaceShell): string {
  return [
    "## Workspace",
    `You run commands directly on the host: a real shell (${sandbox.shellPath}), not an isolated environment. Host files and commands are visible, and changes are written to disk.`,
    `Current working directory: ${sandbox.cwd}`,
    "There are no virtual mounts: relative paths resolve against the current working directory; write other paths as absolute host paths.",
    "Network: available through the host network.",
    `Command timeout: ${sandbox.timeoutMs} ms; a timeout returns exit code 124.`,
    `Executor output safety limit: ${sandbox.maxExecutionOutputBytes} bytes. Inside codemode you receive the raw output; the runtime handles model-visible previews and archives. Return structured results instead of stringifying or slicing them yourself.`,
    "Shell state does not persist between calls: cd, aliases, functions, and exported variables are not retained. Put a directory change on the same line (cd <dir> && <command>).",
    // Platform media and long outputs do not live on the host filesystem; bash cannot read them, only the runtime resource URLs can.
    "Platform media and long tool outputs are available through the runtime read tool's asset:// and artifact:// URLs; bash cannot read them as files.",
    "You can also read a known file through read's workspace:// URL: workspace:///<host-absolute-path> (write Windows drive letters in the /d/... style, e.g. workspace:///d/work/a.txt). It resolves to the same host file.",
    "Use read_file to read a known file, write_file to replace a file, edit_file for a small edit, and bash for listing, searching, and pipelines.",
  ].join("\n");
}

function sandboxInstructions(sandbox: WorkspaceShell): string {
  return [
    "## Workspace",
    "You read and write files in a per-instance sandbox, not on the host: commands are interpreted by JavaScript, only the mounted paths below exist, and host paths and commands are invisible.",
    "The command set is not the host's.",
    `Current working directory: ${sandbox.cwd}`,
    "Mounts:",
    `- ${HOME_MOUNT}: read-only, this instance's data directory (writes fail)`,
    `- ${WORKSPACE_MOUNT}: read-write, working directory (changes are written to disk)`,
    ...(sandbox.resourcesMounted
      ? [
          `- ${ISHIKI_MOUNT}: read-only, resource center (assets/ holds platform media; artifacts/ holds tool media and full long outputs; these correspond to the read tool's asset:// and artifact:// URLs)`,
        ]
      : []),
    // The skills mounts are summarized on one line below instead of repeating the Skills section.
    ...sandbox.mounts
      .filter((mount) => !mount.target.startsWith(`${SKILLS_MOUNT}/`))
      .map((mount) => `- ${mount.target}: ${mount.readOnly ? "read-only (writes fail)" : "read-write (changes are written to disk)"}`),
    ...(sandbox.skills.length > 0 ? [`- ${SKILLS_MOUNT}: read-only, skills directory (see below)`] : []),
    `Network: ${sandbox.network ? "available; private addresses are rejected" : "unavailable"}`,
    `Command timeout: ${sandbox.timeoutMs} ms; a timeout returns exit code 124.`,
    `Executor output safety limit: ${sandbox.maxExecutionOutputBytes} bytes. Inside codemode you receive the raw output; the runtime handles model-visible previews and archives. Return structured results instead of stringifying or slicing them yourself.`,
    "Shell state does not persist between calls: cd, aliases, functions, and exported variables are not retained. Put a directory change on the same line (cd <dir> && <command>).",
    ...(sandbox.javascript
      ? [
          "js-exec is available: run JavaScript / TypeScript in QuickJS. Some node modules can be required or imported; only files inside the sandbox are accessible.",
        ]
      : []),
    ...(sandbox.python
      ? [
          "python3 and python are available: CPython compiled to WebAssembly with the full standard library. The first call waits for it to load; reads and writes target this sandbox.",
        ]
      : []),
    "You can also read a known file through read's workspace:///<sandbox-path> URL (e.g. workspace:///home/workspace/a.txt): virtual files, persistent directories, and mounts all resolve to the same sandbox file.",
    "Use read_file to read a known file, write_file to replace a file, edit_file for a small edit, and bash for listing, searching, and pipelines.",
  ].join("\n");
}
