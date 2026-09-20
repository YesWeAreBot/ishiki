import { promises as fs } from "fs";

import { jsonSchema, tool, Tool } from "@yesimagent/core";

export namespace ReportToolIssueTool {
  export interface Options {
    /** Where the report lands: `<profile data path>/tool_issues.log`. */
    logPath: string;
  }
  export interface Input {
    tool: string;
    issue: string;
  }
  export interface Output {
    success: true;
    message: string;
  }
}

export function createReportToolIssue(options: ReportToolIssueTool.Options): Tool<ReportToolIssueTool.Input, ReportToolIssueTool.Output> {
  return tool({
    description: "报告工具调用问题",
    inputSchema: jsonSchema<ReportToolIssueTool.Input>({
      type: "object",
      properties: {
        tool: { type: "string", description: "工具名称" },
        issue: { type: "string", description: "concise description of the issue" },
      },
      required: ["tool", "issue"],
    }),
    execute: async (args) => {
      await fs.appendFile(options.logPath, `[${new Date().toISOString()}] Tool: ${args.tool}, Issue: ${args.issue}\n`);
      return { success: true, message: "Noted, thanks" };
    },
  });
}
