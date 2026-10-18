import { jsonSchema, tool, type ToolSet } from "koishi-plugin-ishiki";

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

export function createWorkspaceTools(sandbox: WorkspaceShell): ToolSet {
  const native = sandbox.backend === "native";
  return {
    bash: tool({
      description: native
        ? [
            "Run one command in the host shell (" + sandbox.shellPath + ").",
            "This is a real shell and a real filesystem: host files and commands are visible, and changes are written to disk.",
            "Write paths outside the current working directory in full. cd, aliases, functions, and exported variables do not persist between calls.",
            "Returns stdout, stderr, and an exit code. A non-zero exit code means the command itself failed; its output is still valid, so read stderr before deciding to retry.",
          ].join("\n")
        : [
            "Run a bash command inside the sandbox.",
            "The sandbox is a JavaScript-interpreted virtual environment, not a host shell: only files under the mounts are visible, and the command set is not the host's.",
            "Write paths outside the current working directory in full. cd, aliases, functions, and exported variables do not persist between calls.",
            "Returns stdout, stderr, and an exit code. A non-zero exit code means the command itself failed; its output is still valid, so read stderr before deciding to retry.",
          ].join("\n"),
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
        return { type: "text" as const, value: sections.join("\n\n") };
      },
      execute: (input, options) => sandbox.exec(input.command, options.abortSignal),
    }),
    read_file: tool({
      description: [
        native ? "Read the entire contents of a file on the host." : "Read the entire contents of a file in the sandbox.",
        "path may be absolute or relative to the current working directory.",
        "If you do not know where the file is, locate it first with bash ls, find, or grep.",
      ].join("\n"),
      inputSchema: jsonSchema<PathInput>({
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
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
      description: [
        native
          ? "Write content to a file on the host, replacing it if it exists; parent directories are created automatically."
          : "Write content to a file in the sandbox, replacing it if it exists; parent directories are created automatically.",
        "Use edit_file for a small change instead of rewriting the whole file.",
        "Returns the number of bytes written.",
      ].join("\n"),
      inputSchema: jsonSchema<WriteInput>({
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
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
      description: [
        "Make a precise replacement inside a file. Use this for a small edit.",
        "old_string must match the file exactly, including indentation and whitespace; an empty new_string deletes the matched text.",
        "By default only a unique match is replaced: multiple matches raise an error. Set replace_all to true to replace every occurrence.",
        "If old_string is missing or matches more than once while replace_all is false, the file is left unchanged and an error is raised. Retry with a longer old_string.",
      ].join("\n"),
      inputSchema: jsonSchema<EditInput>({
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
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
