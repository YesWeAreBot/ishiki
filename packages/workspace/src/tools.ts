import { jsonSchema, Template, tool, type ToolSet } from "koishi-plugin-ishiki";

import type { ExecResult, WorkspaceShell } from "./shell.js";

interface PathInput {
  path: string;
}

interface WriteInput extends PathInput {
  content: string;
}

interface EditInput extends PathInput {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

type ToolPromptData = {
  native: boolean;
  shellPath: string;
  gitBashPaths: boolean;
};

// @huggingface/jinja drops the newline that follows a tag, so each tag occupies its own line and
// branch text starts at column zero; the rendered text keeps the line breaks written here. A template
// that ends with a block tag leaves one trailing newline, trimmed where the description is rendered.
const PATH_DESCRIPTION = new Template(
  `File path; relative paths resolve against the current working directory.
{% if gitBashPaths %}
A Windows absolute path is accepted as D:/dir/file and as the git-bash spelling /d/dir/file.
Keep scratch files under the working directory (./tmp/...); /tmp resolves differently in the shell, in a program you start, and in the file tools.
{% endif %}`,
);

const BASH_DESCRIPTION = new Template(
  `{% if native %}
Run one command in the host shell ({{ shellPath }}).
This is a real shell and a real filesystem: host files and commands are visible, and changes are written to disk.
{% else %}
Run a bash command inside the sandbox.
The sandbox is a JavaScript-interpreted virtual environment, not a host shell: only files under the mounts are visible, and the command set is not the host's.
{% endif %}
Write paths outside the current working directory in full. cd, aliases, functions, and exported variables do not persist between calls.
{% if not native %}
/tmp belongs to the current sandbox lifetime. Read a /tmp file only after the same or an earlier successful call created it; a failed or timed-out call may leave nothing behind. Write results that must survive to the workspace or an artifact.
{% endif %}
{% if gitBashPaths %}
Command text follows git-bash path syntax: /d/work means D:\\work. A path inside a string that only gets handed to another program (a JavaScript string passed to node, a config value) is not converted, so write D:/... there.
Write scratch files under the working directory rather than /tmp: the shell, a program it starts, and the file tools may resolve /tmp to different folders.
{% endif %}
Returns stdout, stderr, and an exit code. A non-zero exit code means the command itself failed; its output is still valid, so read stderr before deciding to retry.`,
);

const READ_FILE_DESCRIPTION = new Template(
  `{% if native %}
Read the entire contents of a file on the host.
{% else %}
Read the entire contents of a file in the sandbox.
{% endif %}
path may be absolute or relative to the current working directory.
If you do not know where the file is, locate it first with bash ls, find, or grep.`,
);

const WRITE_FILE_DESCRIPTION = new Template(
  `{% if native %}
Write content to a file on the host, replacing it if it exists; parent directories are created automatically.
{% else %}
Write content to a file in the sandbox, replacing it if it exists; parent directories are created automatically.
{% endif %}
Use edit_file for a small change instead of rewriting the whole file.
Returns the number of bytes written.`,
);

const EDIT_FILE_DESCRIPTION = new Template(
  `Make a precise replacement inside a file. Use this for a small edit.
old_string must match the file exactly, including indentation and whitespace; an empty new_string deletes the matched text.
By default only a unique match is replaced: multiple matches raise an error. Set replace_all to true to replace every occurrence.
If old_string is missing or matches more than once while replace_all is false, the file is left unchanged and an error is raised. Retry with a longer old_string.`,
);

export function createWorkspaceTools(sandbox: WorkspaceShell): ToolSet {
  const native = sandbox.backend === "native";
  // Git Bash on Windows reads /d/work and /tmp itself, but text handed to another program keeps its literal characters.
  const gitBashPaths = native && process.platform === "win32" && sandbox.shellKind === "posix";
  const prompt: ToolPromptData = { native, shellPath: sandbox.shellPath, gitBashPaths };
  const pathDescription = PATH_DESCRIPTION.render(prompt).trimEnd();
  const bashDescription = BASH_DESCRIPTION.render(prompt);
  return {
    bash: tool({
      description: bashDescription,
      inputSchema: jsonSchema<{ command: string }>({
        type: "object",
        properties: {
          command: { type: "string", description: "Command to run; chain multiple steps with && on one line." },
        },
        required: ["command"],
      }),
      outputSchema: jsonSchema<ExecResult>({
        type: "object",
        properties: {
          stdout: { type: "string", description: "Standard output" },
          stderr: { type: "string", description: "Standard error" },
          exitCode: { type: "number", description: "Exit code; 0 means success" },
        },
        required: ["stdout", "stderr", "exitCode"],
      }),
      // 纯文本渲染让 stdout 保持多行形态；JSON 转义会把整段输出折成一行，
      // 超长截断后的行锚点就失效了。
      toModelOutput: ({ output }) => {
        const sections = [`exit code: ${output.exitCode}`];
        if (output.stdout.length > 0) sections.push(`stdout:\n${output.stdout}`);
        if (output.stderr.length > 0) sections.push(`stderr:\n${output.stderr}`);
        return { type: output.exitCode === 0 ? ("text" as const) : ("error-text" as const), value: sections.join("\n\n") };
      },
      execute: (input, options) => sandbox.exec(input.command, options.abortSignal),
    }),
    read_file: tool({
      description: READ_FILE_DESCRIPTION.render(prompt),
      inputSchema: jsonSchema<PathInput>({
        type: "object",
        properties: {
          path: { type: "string", description: pathDescription },
        },
        required: ["path"],
      }),
      outputSchema: jsonSchema<{ content: string }>({
        type: "object",
        properties: {
          content: { type: "string", description: "Full file contents" },
        },
        required: ["content"],
      }),
      toModelOutput: ({ output }) => ({ type: "text" as const, value: output.content }),
      execute: async (input) => ({ content: await sandbox.read(input.path) }),
    }),
    write_file: tool({
      description: WRITE_FILE_DESCRIPTION.render(prompt),
      inputSchema: jsonSchema<WriteInput>({
        type: "object",
        properties: {
          path: { type: "string", description: pathDescription },
          content: { type: "string", description: "Full file contents" },
        },
        required: ["path", "content"],
      }),
      outputSchema: jsonSchema<{ ok: boolean; bytes: number }>({
        type: "object",
        properties: {
          ok: { type: "boolean", description: "Whether the write succeeded" },
          bytes: { type: "number", description: "Number of bytes written" },
        },
        required: ["ok", "bytes"],
      }),
      execute: async (input) => {
        await sandbox.write(input.path, input.content);
        return { ok: true as const, bytes: Buffer.byteLength(input.content, "utf8") };
      },
    }),
    edit_file: tool({
      description: EDIT_FILE_DESCRIPTION.render(prompt),
      inputSchema: jsonSchema<EditInput>({
        type: "object",
        properties: {
          path: { type: "string", description: pathDescription },
          old_string: { type: "string", description: "Exact text to replace, character for character" },
          new_string: { type: "string", description: "Replacement text; an empty string deletes the match" },
          replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match" },
        },
        required: ["path", "old_string", "new_string"],
      }),
      outputSchema: jsonSchema<{ ok: boolean; replacements: number }>({
        type: "object",
        properties: {
          ok: { type: "boolean", description: "Whether the replacement succeeded" },
          replacements: { type: "number", description: "Number of replacements made" },
        },
        required: ["ok", "replacements"],
      }),
      execute: async (input) => {
        const content = await sandbox.read(input.path);
        if (input.old_string === input.new_string) throw new Error("old_string and new_string are identical; the file was not changed");
        if (input.old_string.length === 0) throw new Error("old_string must not be empty");
        const occurrences = content.split(input.old_string).length - 1;
        if (occurrences === 0) throw new Error("old_string was not found in the file; it must match the file exactly, including indentation and whitespace");
        const replaceAll = input.replace_all === true;
        if (!replaceAll && occurrences > 1) {
          throw new Error(
            `old_string appears ${occurrences} times in the file; set replace_all to true to replace every occurrence, or use a longer old_string that identifies one location`,
          );
        }
        await sandbox.write(
          input.path,
          replaceAll ? content.replaceAll(input.old_string, input.new_string) : content.replace(input.old_string, input.new_string),
        );
        return { ok: true as const, replacements: replaceAll ? occurrences : 1 };
      },
    }),
  };
}
