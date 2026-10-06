import path from "node:path";

import { jsonSchema, tool, type ToolSet } from "koishi-plugin-ishiki";

import type { ExecResult, WorkspaceSandbox } from "./sandbox.js";

function resolveIn(sandbox: WorkspaceSandbox, target: string): string {
  return target.startsWith("/") ? target : path.posix.join(sandbox.cwd, target);
}

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

export function createWorkspaceTools(sandbox: WorkspaceSandbox): ToolSet {
  return {
    bash: tool({
      description: [
        "在沙箱内执行一条 bash 命令。",
        "沙箱是 JavaScript 解释执行的虚拟环境，不是宿主机 shell：只有挂载点内的文件可见，命令集也不是宿主机那一套。",
        "当前工作目录之外的路径要写全；cd、别名、函数、导出变量都不跨调用保留。",
        "返回 stdout、stderr 与退出码。退出码非 0 表示命令本身失败，内容仍然有效，先读 stderr 再决定重试。",
      ].join("\n"),
      inputSchema: jsonSchema<{ command: string }>({
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令；可在同一条里用 && 串联多步" },
        },
        required: ["command"],
      }),
      outputSchema: jsonSchema<ExecResult>({
        type: "object",
        properties: {
          stdout: { type: "string", description: "标准输出" },
          stderr: { type: "string", description: "标准错误" },
          exitCode: { type: "number", description: "命令的退出码，0 表示成功" },
        },
        required: ["stdout", "stderr", "exitCode"],
      }),
      execute: (input, options) => sandbox.exec(input.command, options.abortSignal),
    }),
    read_file: tool({
      description: [
        "读取沙箱内一个文件的全部内容。",
        "path 可以是沙箱内的绝对路径，也可以是相对当前工作目录的路径。",
        "不知道文件在哪时先用 bash 的 ls、find、grep 定位。",
      ].join("\n"),
      inputSchema: jsonSchema<PathInput>({
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
        },
        required: ["path"],
      }),
      outputSchema: jsonSchema<{ content: string }>({
        type: "object",
        properties: {
          content: { type: "string", description: "文件的全部内容" },
        },
        required: ["content"],
      }),
      execute: async (input) => ({ content: await sandbox.read(resolveIn(sandbox, input.path)) }),
    }),
    write_file: tool({
      description: [
        "把内容整体写入沙箱内一个文件，已存在则覆盖，父目录会自动创建。",
        "只改文件里的一小段时用 edit_file，不要整文件重写。",
        "返回写入后的字节数。",
      ].join("\n"),
      inputSchema: jsonSchema<WriteInput>({
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          content: { type: "string", description: "文件的完整内容" },
        },
        required: ["path", "content"],
      }),
      outputSchema: jsonSchema<{ ok: boolean; bytes: number }>({
        type: "object",
        properties: {
          ok: { type: "boolean", description: "是否写入成功" },
          bytes: { type: "number", description: "写入的字节数" },
        },
        required: ["ok", "bytes"],
      }),
      execute: async (input) => {
        const target = resolveIn(sandbox, input.path);
        await sandbox.write(target, input.content);
        return { ok: true as const, bytes: Buffer.byteLength(input.content, "utf8") };
      },
    }),
    edit_file: tool({
      description: [
        "在文件里做精确替换，用来改文件的一小段。",
        "old_string 必须与文件内容逐字符一致，缩进与空白都算；new_string 为空表示删除这段内容。",
        "默认只替换唯一的一处：出现多次时报错，需要全部替换才把 replace_all 设为 true。",
        "找不到 old_string、或它出现多次而 replace_all 为 false 时，文件保持原样并报错，重写一段更长的 old_string 再试。",
      ].join("\n"),
      inputSchema: jsonSchema<EditInput>({
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          old_string: { type: "string", description: "要被替换掉的原文本，必须逐字符一致" },
          new_string: { type: "string", description: "替换成的文本，空字符串表示删除" },
          replace_all: { type: "boolean", description: "是否替换全部出现的位置，缺省只替换唯一的一处" },
        },
        required: ["path", "old_string", "new_string"],
      }),
      outputSchema: jsonSchema<{ ok: boolean; replacements: number }>({
        type: "object",
        properties: {
          ok: { type: "boolean", description: "是否替换成功" },
          replacements: { type: "number", description: "实际替换的处数" },
        },
        required: ["ok", "replacements"],
      }),
      execute: async (input) => {
        const target = resolveIn(sandbox, input.path);
        const content = await sandbox.read(target);
        if (input.old_string === input.new_string) throw new Error("old_string 与 new_string 相同，文件未改动");
        if (input.old_string.length === 0) throw new Error("old_string 不能为空");
        const occurrences = content.split(input.old_string).length - 1;
        if (occurrences === 0) throw new Error("old_string 未在文件中出现；它必须与文件内容逐字符一致，包含缩进与空白");
        const replaceAll = input.replace_all === true;
        if (!replaceAll && occurrences > 1) {
          throw new Error(`old_string 在文件中出现 ${occurrences} 次；把 replace_all 设为 true 全部替换，或写一段能唯一定位的 old_string`);
        }
        await sandbox.write(target, replaceAll ? content.replaceAll(input.old_string, input.new_string) : content.replace(input.old_string, input.new_string));
        return { ok: true as const, replacements: replaceAll ? occurrences : 1 };
      },
    }),
  };
}
