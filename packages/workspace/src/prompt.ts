import { Template } from "koishi-plugin-ishiki";

import { HOME_MOUNT, ISHIKI_MOUNT, SKILLS_MOUNT, WORKSPACE_MOUNT } from "./mounts.js";
import type { WorkspaceShell } from "./shell.js";

const NATIVE_INSTRUCTIONS = new Template(
  `## Workspace
You run commands directly on the host: a real shell ({{ shellPath }}), not an isolated environment. Host files and commands are visible, and changes are written to disk.
Current working directory: {{ cwd }}
There are no virtual mounts: relative paths resolve against the current working directory; write other paths as absolute host paths.
Network: available through the host network.
Command timeout: {{ timeoutMs }} ms; a timeout returns exit code 124.
Executor output safety limit: {{ maxExecutionOutputBytes }} bytes. Inside codemode you receive the raw output; the runtime handles model-visible previews and archives. Return structured results instead of stringifying or slicing them yourself.
Shell state does not persist between calls: cd, aliases, functions, and exported variables are not retained. Put a directory change on the same line (cd <dir> && <command>).
Platform media and long tool outputs are available through the runtime read tool's asset:// and artifact:// URLs; bash cannot read them as files.
You can also read a known file through read's workspace:// URL: workspace:///<host-absolute-path> (write Windows drive letters in the /d/... style, e.g. workspace:///d/work/a.txt). It resolves to the same host file.
Use read_file to read a known file, write_file to replace a file, edit_file for a small edit, and bash for listing, searching, and pipelines.`,
);

const SANDBOX_INSTRUCTIONS = new Template(
  `## Workspace
You read and write files in a per-instance sandbox, not on the host: commands are interpreted by JavaScript, only the mounted paths below exist, and host paths and commands are invisible.
The command set is not the host's.
Current working directory: {{ cwd }}
Mounts:
- {{ homeMount }}: read-only, this instance's data directory (writes fail)
- {{ workspaceMount }}: read-write, working directory (changes are written to disk)
{% if resourcesMounted %}
- {{ ishikiMount }}: read-only, resource center (assets/ holds platform media; artifacts/ holds tool media and full long outputs; these correspond to the read tool's asset:// and artifact:// URLs)
{% endif %}
{% for mount in mounts %}
- {{ mount.target }}: {{ mount.access }}
{% endfor %}
{% if skillsMounted %}
- {{ skillsMount }}: read-only, skills directory (see below)
{% endif %}
Network: {{ network }}
Command timeout: {{ timeoutMs }} ms; a timeout returns exit code 124.
Executor output safety limit: {{ maxExecutionOutputBytes }} bytes. Inside codemode you receive the raw output; the runtime handles model-visible previews and archives. Return structured results instead of stringifying or slicing them yourself.
Shell state does not persist between calls: cd, aliases, functions, and exported variables are not retained. Put a directory change on the same line (cd <dir> && <command>).
{% if javascript %}
js-exec is available: run JavaScript / TypeScript in QuickJS. Some node modules can be required or imported; only files inside the sandbox are accessible.
{% endif %}
{% if python %}
python3 and python are available: CPython compiled to WebAssembly with the full standard library. The first call waits for it to load; reads and writes target this sandbox.
{% endif %}
You can also read a known file through read's workspace:///<sandbox-path> URL (e.g. workspace:///home/workspace/a.txt): virtual files, persistent directories, and mounts all resolve to the same sandbox file.
Use read_file to read a known file, write_file to replace a file, edit_file for a small edit, and bash for listing, searching, and pipelines.`,
);

export function workspaceInstructions(sandbox: WorkspaceShell): string {
  if (sandbox.backend === "native") {
    return NATIVE_INSTRUCTIONS.render({
      shellPath: sandbox.shellPath,
      cwd: sandbox.cwd,
      timeoutMs: sandbox.timeoutMs,
      maxExecutionOutputBytes: sandbox.maxExecutionOutputBytes,
    });
  }

  return SANDBOX_INSTRUCTIONS.render({
    cwd: sandbox.cwd,
    homeMount: HOME_MOUNT,
    workspaceMount: WORKSPACE_MOUNT,
    ishikiMount: ISHIKI_MOUNT,
    resourcesMounted: sandbox.resourcesMounted,
    skillsMount: SKILLS_MOUNT,
    skillsMounted: sandbox.skills.length > 0,
    // Skills mounts are summarized on one line in the template instead of repeating the Skills section.
    mounts: sandbox.mounts
      .filter((mount) => !mount.target.startsWith(`${SKILLS_MOUNT}/`))
      .map((mount) => ({ target: mount.target, access: mount.readOnly ? "read-only (writes fail)" : "read-write (changes are written to disk)" })),
    network: sandbox.network ? "available; private addresses are rejected" : "unavailable",
    timeoutMs: sandbox.timeoutMs,
    maxExecutionOutputBytes: sandbox.maxExecutionOutputBytes,
    javascript: sandbox.javascript,
    python: sandbox.python,
  });
}
