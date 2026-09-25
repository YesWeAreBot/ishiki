import { jsonSchema, tool, Tool } from "@yesimagent/core";

import type { StimulusReport, StimulusTarget, StimulusUrgency } from "../runtime.js";

export namespace DispatchStimulusTool {
  export interface Options {
    /** 投递方实例：`sid` 省略时以它为默认目标账号，也是自我投递的判据。 */
    self: { sid: string; channelId: string };
    /** 交给容器：目标校验、实例创建与投递都在那里。 */
    dispatch: (targets: readonly StimulusTarget[], body: { reason: string; content: string; urgency: StimulusUrgency }) => StimulusReport;
  }
  export interface Input {
    targets: StimulusTarget[];
    reason: string;
    content: string;
    urgency?: StimulusUrgency;
  }
  export type Output =
    | { ok: true; delivered: number; refused: StimulusReport["refused"] }
    | { ok: false; error: { name: string; message: string }; refused: StimulusReport["refused"] };
}

export function createDispatchStimulus(options: DispatchStimulusTool.Options): Tool<DispatchStimulusTool.Input, DispatchStimulusTool.Output> {
  return tool({
    description: [
      "跨场景的投递通道。向另一个场景投递一条内部刺激，由目标场景按本地上下文自行判断是否输出。",
      "这是本场景影响其他场景的唯一出口：本场景不能代为在别处发言。投递的是事件与动机，不是成句的文本。",
      'urgency 默认为 "idle"：只写入目标场景的事实流，目标在其下一次唤醒时读取。返回的 delivered 表示已写入，不表示目标已读取。',
      '"urgent" 会立即触发目标场景的一轮推理，仅用于必须即时送达的事件。',
      "targets 必须显式给出，地址取自系统提示中的可达地址。目标唯一时只投一个地址，禁止向多个频道重复投递同一事件。",
      "本轮由内部刺激触发时，不得再调用本工具。",
    ].join("\n"),
    inputSchema: jsonSchema<DispatchStimulusTool.Input>({
      type: "object",
      properties: {
        targets: {
          type: "array",
          minItems: 1,
          description: "投递目标数组，每项 { sid?, channelId }；sid 省略即当前场景的账号。必须是本 profile 名下的场景。",
          items: {
            type: "object",
            properties: {
              sid: { type: "string", description: "账号 sid（platform:selfId）；省略即当前场景的账号" },
              channelId: { type: "string", minLength: 1, description: "目标频道 ID" },
            },
            required: ["channelId"],
          },
        },
        reason: { type: "string", minLength: 1, description: "投递动机：为什么需要目标场景知晓此事" },
        content: { type: "string", minLength: 1, description: "事件内容：目标场景需要知晓的事实" },
        urgency: {
          type: "string",
          enum: ["idle", "urgent"],
          description: '默认 "idle"：仅写入目标事实流，等目标下次唤醒；"urgent"：立即触发目标一轮推理，仅限必须即时送达的事件',
        },
      },
      required: ["targets", "reason", "content"],
    }),
    execute: async (input) => {
      if (!Array.isArray(input.targets) || input.targets.length === 0) {
        return { ok: false as const, error: { name: "InvalidInput", message: "targets 必须是非空数组" }, refused: [] };
      }
      if (typeof input.reason !== "string" || input.reason.length === 0 || typeof input.content !== "string" || input.content.length === 0) {
        return { ok: false as const, error: { name: "InvalidInput", message: "reason 与 content 都必须是非空字符串" }, refused: [] };
      }
      const urgency = input.urgency ?? "idle";
      if (urgency !== "idle" && urgency !== "urgent") {
        return { ok: false as const, error: { name: "InvalidInput", message: 'urgency 只能是 "idle" 或 "urgent"' }, refused: [] };
      }

      const targets: StimulusTarget[] = input.targets.map((target) => ({
        ...(target?.sid === undefined ? {} : { sid: String(target.sid) }),
        channelId: String(target?.channelId ?? ""),
      }));
      if (targets.some((target) => target.channelId.length === 0)) {
        return { ok: false as const, error: { name: "InvalidInput", message: "每个目标都要给出 channelId" }, refused: [] };
      }
      if (targets.some((target) => (target.sid ?? options.self.sid) === options.self.sid && target.channelId === options.self.channelId)) {
        return {
          ok: false as const,
          error: { name: "SelfTarget", message: `目标里有当前场景自己（${options.self.sid}/${options.self.channelId}）` },
          refused: [],
        };
      }

      const report = options.dispatch(targets, { reason: input.reason, content: input.content, urgency });
      if (report.delivered === 0) {
        return { ok: false as const, error: { name: "NotDelivered", message: "没有任何目标收到这条投递" }, refused: report.refused };
      }
      return { ok: true as const, delivered: report.delivered, refused: report.refused };
    },
  });
}
