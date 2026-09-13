import { jsonSchema, type FunctionTool } from "@yesimagent/core";
import { Context, h, Random, sleep } from "koishi";

export namespace SendMessageTool {
  export interface Input {
    inner_thought?: string;
    mode: "element" | "raw";
    channel?: string;
    messages: string[];
    continue?: boolean;
  }
  export type Output =
    | { ok: true; messageIds: string[]; count: number }
    | { ok: false; error: { name: string; message: string }; sent: string[]; failedAt: number };
  export interface Options {
    enableInnerThought: boolean;
  }
  export interface ToolContext {
    ctx: Context;
    selfId: string;
  }
}

export function createSendMessageTool(
  options: SendMessageTool.Options,
): FunctionTool<SendMessageTool.Input, SendMessageTool.Output, SendMessageTool.ToolContext> {
  return {
    description: sendMessageDescription(options.enableInnerThought),
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        ...(options.enableInnerThought
          ? {
              inner_thought: {
                type: "string",
                description: "本次发送前的内心独白；只保留在你自己的历史里，不会发送给任何人",
              },
            }
          : {}),
        mode: {
          type: "string",
          enum: ["element", "raw"],
          description: "element（默认）解析消息元素；raw 原样发送纯文本",
        },
        channel: { type: "string", minLength: 1, description: "目标频道 ID" },
        messages: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
          description: "要发送的消息，每一项作为一条独立消息按顺序发出",
        },
        continue: {
          type: "boolean",
          description: "true 时发送后继续生成下一步，可以再调用工具或再次发送消息",
        },
      },
      required: ["messages", "channel"],
    }),
    inputExamples: [],
    execute: async (input, { context }) => {
      const services: SendMessageTool.ToolContext | undefined = context;
      if (!services?.ctx) {
        throw new Error("send_message requires toolsContext.send_message = { ctx, selfId }");
      }
      const bot = services.ctx.bots.find((bot) => bot.selfId === services.selfId);
      if (!bot) {
        return {
          ok: false,
          error: { name: "BotNotFound", message: `Bot with selfId ${services.selfId} not found` },
          sent: [],
          failedAt: 0,
        };
      }
      const messages = Array.isArray(input.messages) ? input.messages : [];
      if (messages.length === 0)
        return {
          ok: false,
          error: { name: "InvalidInput", message: "messages is empty" },
          sent: [],
          failedAt: 0,
        };
      if (messages.some((m) => typeof m !== "string" || m.length === 0))
        return {
          ok: false,
          error: { name: "InvalidInput", message: "messages must be non-empty strings" },
          sent: [],
          failedAt: 0,
        };
      if (input.mode && input.mode !== "element" && input.mode !== "raw")
        return {
          ok: false,
          error: { name: "InvalidInput", message: `mode must be "element" or "raw"` },
          sent: [],
          failedAt: 0,
        };
      const channel = input.channel;
      if (typeof channel !== "string")
        return {
          ok: false,
          error: { name: "InvalidInput", message: `channel must be a string` },
          sent: [],
          failedAt: 0,
        };
      const mode = input.mode ?? "element";
      const ids: string[] = [];
      for (const msg of messages) {
        if (mode === "element") {
          const result = await bot.sendMessage(channel, msg);
          ids.push(...result);
          await sleep(Random.int(1000, 3000));
        } else if (mode === "raw") {
          const result = await bot.sendMessage(channel, h.text(msg));
          ids.push(...result);
          await sleep(Random.int(1000, 3000));
        }
      }
      return {
        ok: true,
        messageIds: ids,
        count: ids.length,
      };
    },
  };
}

function sendMessageDescription(innerThought: boolean): string {
  return `向频道发送消息。这是消息到达平台的唯一途径——你的文本输出不会被发送，只有本工具发出的内容会被别人看到。

调用后生成一条真正展示给用户的回复。你可以针对某个用户回复，也可以对所有用户回复。发言必须通过send_message工具，不然用户无法看见，这是你与用户交流的唯一途径。。

# 参数

## messages
要发送的消息列表，每一项作为一条独立消息按顺序发出。
让分条跟随对话节奏：快速反应和深思熟虑的解释各有恰当的时刻，不要固守习惯性的条数或长度。读者逐条看到消息，每次分条都会让半截回复单独停留片刻，只在不伤害这种「半截状态」的地方分条。事实、指令、代码、链接、结构化内容、修正，以及任何后果重大的内容，都应保持在同一条消息内。
不要用空行分段。平台不会把空行渲染成视觉分隔，它只是一个被吞掉的空白，让消息看起来格式奇怪。需要分开就分成多条。

## channel
目标频道 ID。留空发往当前频道；填写其他频道 ID 可以向该频道发送。

## mode
- element（默认）：内容按下面的消息元素语法解析，<img> 与 <file> 的资源 URI 会被解析成真实内容。
- raw：内容作为字面量原样发送，不解析任何元素。尖括号、& 和引号都不需要转义，你写下的每个字符原样到达接收方。发送代码、日志、命令行输出、含大量特殊字符的文本，或需要精确控制每个字符时用它。

## continue
默认 false。设为 true 时，发送后继续生成下一步，可以再调用工具或再次发送消息。需要「先回应再去做事」或「分几次发送并在中间查资料」时用它。
${
  innerThought
    ? `
## inner_thought
本次发送前的内心活动——感受当前场景的氛围、形成对正在发生的事的判断、规划接下来的行动，或反思之前的选择。
它不会到达平台，任何人都看不到，但会保留在你自己的历史里，之后你能看到当时想了什么。不要把其中的话当作已经说出口；需要让对方知道某个判断，必须另外写进 messages。没有固定长度或频率要求，不需要每次都写。
`
    : ""
}
# 返回值
成功返回 {ok:true, messageIds, count}。
失败返回 {ok:false, error, sent, failedAt}：sent 是已经成功发出的消息 ID，failedAt 是出错的 messages 下标。发送遇错会立即停止，failedAt 及其之后的消息都没有发出。必须检查 ok，不要假设发送成功。

# 消息元素（仅 mode=element）
消息元素的语法与 HTML 类似，形如 <名称 属性="值"/>。你观察到的消息由元素组成，你发出的消息使用同一套元素：普通文本直接写，结构元素直接放在文本里。
元素名只能由小写字母、数字和连字符组成，且以字母开头。不符合规则的标签形式会被当作普通文本——但如果你的文本恰好长得像合法元素名，它就会被错误解析。这就是为什么转义很重要。

## 常用元素
<at id="用户ID"/>：提及某人。id 填用户 ID，不是昵称。
<at type="all"/>：提及全体成员。<at type="here"/>：提及在线成员。
<quote id="消息ID"/>：引用某条消息。id 取自该消息观察头的 id。
<img src="…"/>：图片。src 支持频道资源 URI。
<file src="…"/>：文件。src 支持频道资源 URI。
<audio src="…"/>：语音。src 只能是平台可直接访问的地址。
<video src="…"/>：视频。src 只能是平台可直接访问的地址。
<text>…</text>：逐字交付的纯文本块。其中的内容不会被解析成元素，所有字符原样到达接收方。用它包裹含尖括号的代码、标签示例、泛型签名等片段。整条消息都是这类内容时，直接用 mode=raw 更省事。

## 转义（关键）
< 和 > 如果没有转义，系统会尝试把它们之间的内容解析为元素。如果解析成功，你原本想输出的文字就会消失——这不是显示异常，而是内容被永久吞掉。
例如：你想说「当 a<b 且 c>d 时」，但 <b 且 c> 看起来像一个元素，会被解析掉，接收方看到的是「当 a d 时」。
规则：文本中出现的 <、>、&、" 如果不是用来构成元素标签，必须转义。
| 字符 | 转义 | 何时需要 |
|:---:|:---:|:---|
| < | &lt; | 文本中所有非元素用途的 < |
| > | &gt; | 文本中所有非元素用途的 > |
| & | &amp; | 文本中的 &（否则会被当作转义序列开头） |
| " | &quot; | 元素属性值内的引号 |

## 示例
普通对话，不需要特殊处理：
messages: ["今天天气不错"]

分多条发送：
messages: ["先说结论", "具体原因是这样的……"]

提及某人并引用消息：
messages: ["<quote id=\\"msg_12345\\"/><at id=\\"114514\\"/> 你说的这个我有不同看法"]

文本中包含尖括号：
messages: ["泛型写法是 Array&lt;string&gt;，不是 Array(string)"]
→ 接收方看到：泛型写法是 Array<string>，不是 Array(string)

发送代码——用 mode=raw 最直接：
mode: "raw", messages: ["function compare<T>(a: T, b: T) {\\n  return a < b;\\n}"]

错误示范——忘记转义：
messages: ["当 x<10 且 y>5 时执行"]
❌ 系统尝试解析 <10 且 y>，内容丢失。改用转义或 mode=raw。`;
}
