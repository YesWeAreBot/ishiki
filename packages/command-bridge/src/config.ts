import { Schema } from "koishi";

import type { CommandPolicy } from "./commands.js";

export interface PluginConfig {
  allow: string[];
  confirm: string[];
  deny: string[];
  maxCallsPerTurn: 1 | 2;
}
export interface ProfileConfig {
  restrictCommands: boolean;
  only: string[];
  deny: string[];
  confirm: string[];
  notes: string[];
  maxCallsPerTurn: 1 | 2;
}
const names = (description: string) => Schema.array(String).default([]).description(description);
const limit = (value: 1 | 2) => Schema.union([1, 2]).default(value).description("每轮代调或发送确认请求的次数上限");
export const pluginConfig: Schema<PluginConfig> = Schema.object({
  allow: names("已审核、可直接代调的普通命令。填写注册名称"),
  confirm: names("可代调但每次都需要发言人确认的命令，例如扣费、点赞、签到"),
  deny: names("额外隐藏且禁止代调的命令"),
  maxCallsPerTurn: limit(1),
});
export const profileConfig: Schema<ProfileConfig> = Schema.object({
  restrictCommands: Schema.boolean().default(false).description("只开放下方勾选的命令"),
  only: names("此 profile 可以代调的命令，受插件级授权范围限制"),
  deny: names("对此 profile 隐藏并禁用的命令"),
  confirm: names("对此 profile 追加本人确认的命令"),
  notes: names("管理员提供的非命令功能说明，仅填写在此 profile 所有频道均适用的功能"),
  maxCallsPerTurn: limit(2),
});

export function resolvePolicy(plugin: PluginConfig, profile: ProfileConfig): CommandPolicy & { maxCallsPerTurn: number } {
  return {
    maxCallsPerTurn: Math.min(plugin.maxCallsPerTurn, profile.maxCallsPerTurn),
    allow: [...new Set([...plugin.allow, ...plugin.confirm])].filter((name) => !profile.restrictCommands || profile.only.includes(name)),
    effects: [...plugin.confirm, ...profile.confirm],
    deny: [...plugin.deny, ...profile.deny],
  };
}
