import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// 一个真的 MCP server，走 stdio 起进程——被测的就是「拉起子进程并与它对话」这条路径，
// 在进程内用假 transport 替掉它等于没测。
//
// 用低层 Server 而不是 McpServer：McpServer.registerTool 的 inputSchema 只收 zod，
// 而 zod 是 SDK 的传递依赖，包里没有，测试进程解析不到。这里手写 JSON Schema，
// 顺带让用例能自由控制工具目录的形状。
//
// 它提供三件工具，用来观察包做了什么：
//   echo     原样回显参数，验参数透传
//   shot     返回一张 1x1 PNG，验图片走字节而不是被 JSON.stringify
//   swapped  只在 SWAP=yes 时注册，验 env 透传到子进程
//   hang     睡 SLOW_MS 毫秒才回，用来验 timeout 真的截断了一次调用
//
// 后两件按环境变量门控：不设就不进目录，别的用例的精确断言不受影响。
// MCP_ECHO_INSTRUCTIONS 非空时把自己声明成有说明的 server，验提示词增量。

// 一张 1x1 的透明 PNG。
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 目录的形状就是这一份；`SWAP=yes` 时多出 swapped 那件。 */
function catalog() {
  const tools = [
    { name: "echo", description: "回显传入的文本。", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "shot", description: "返回一张 PNG。", inputSchema: { type: "object", properties: {} } },
  ];
  if (process.env.SWAP === "yes") tools.push({ name: "swapped", description: "只在 SWAP=yes 时出现。", inputSchema: { type: "object", properties: {} } });
  if (process.env.SLOW_MS !== undefined) tools.push({ name: "hang", description: "睡一会儿再回。", inputSchema: { type: "object", properties: {} } });
  return tools;
}

const server = new Server(
  { name: "echo", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    ...(process.env.MCP_ECHO_INSTRUCTIONS === undefined ? {} : { instructions: process.env.MCP_ECHO_INSTRUCTIONS }),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog() }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "echo") return { content: [{ type: "text", text: args.text }] };
  if (name === "shot") return { content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }] };
  if (name === "swapped") return { content: [{ type: "text", text: "swapped" }] };
  if (name === "hang") {
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.SLOW_MS)));
    return { content: [{ type: "text", text: "等到了" }] };
  }
  throw new Error(`unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
