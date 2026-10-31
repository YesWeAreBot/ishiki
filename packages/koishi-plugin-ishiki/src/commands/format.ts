import type {
  ChannelClaimView,
  EnginesDirectory,
  ExtensionsDirectory,
  GroupView,
  ModelsDocument,
  ProfileCheckReport,
  ProfileSummary,
  ProfileView,
  ProviderView,
  RuntimeState,
  RuntimeView,
  SessionSummary,
} from "../management/types.js";

const PROFILE_STATES: Record<ProfileSummary["state"], string> = { active: "已激活", inactive: "未激活", failed: "失败", loading: "加载中" };
const RUNTIME_STATES: Record<RuntimeState, string> = { idle: "空闲", running: "运行中", stopped: "已停止", failed: "失败" };

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…（共 ${text.length} 字符）`;
}

function when(timestamp: number | undefined): string {
  return timestamp === undefined ? "从未" : new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function secret(state: { configured: boolean; reference?: string }): string {
  if (!state.configured) return "未配置";
  return state.reference ?? "已配置";
}

export function formatProfileList(summaries: ProfileSummary[]): string {
  if (summaries.length === 0) return "还没有任何 Profile，使用 ishiki.profile.create 创建。";
  const lines = summaries.map((summary) => {
    const applied = summary.appliedAt === undefined ? "" : summary.appliedAt >= summary.savedAt ? "" : "（已保存未应用）";
    return `${summary.id}：${summary.model || "未配置模型"} · ${summary.mode} · ${PROFILE_STATES[summary.state]} · ${summary.runtimeCount} 个 Runtime${applied}`;
  });
  return [`Profile 共 ${summaries.length} 个：`, ...lines].join("\n");
}

export function formatProfileView(view: ProfileView): string {
  const channels = Object.entries((view.config.channels as Record<string, string[]> | undefined) ?? {}).map(
    ([sid, patterns]) => `  ${sid}: ${patterns.join(" ")}`,
  );
  const lines = [
    `Profile ${view.id}（${PROFILE_STATES[view.state]}）`,
    `模型：${view.model || "未配置"}`,
    `模式：${view.mode}`,
    `指令文件：${view.instructions.map((file) => (file.missing ? `${file.path}（缺失）` : file.path)).join("、") || "无"}`,
    `频道认领：`,
    ...(channels.length > 0 ? channels : ["  （空）"]),
    `Runtime（${view.runtimes.length}）：${view.runtimes.map((runtime) => runtime.id).join("、") || "无"}`,
    `会话数：${view.sessionCount}`,
    `最近保存：${when(view.savedAt)}，最近应用：${when(view.appliedAt)}`,
  ];
  if (view.lastError !== undefined) lines.push(`最近错误：${view.lastError}`);
  return lines.join("\n");
}

export function formatCheckReport(report: ProfileCheckReport): string {
  const lines = report.items.map((item) => `${item.ok ? "✓" : "✗"} ${item.aspect}${item.ok ? "" : `：${item.message}`}`);
  return [`Profile ${report.id} 校验${report.ok ? "通过" : "未通过"}：`, ...lines].join("\n");
}

export function formatRuntimeList(views: RuntimeView[]): string {
  if (views.length === 0) return "没有匹配的 Runtime 记录。";
  return [
    `Runtime 共 ${views.length} 个（按创建时间倒序）：`,
    ...views.map(
      (view) => `${view.id}：${RUNTIME_STATES[view.state]} · ${view.domainLabel} · ${view.engines.context}/${view.engines.wakeup}/${view.engines.toolcall}`,
    ),
  ].join("\n");
}

export function formatRuntimeView(view: RuntimeView): string {
  const lines = [
    `Runtime ${view.id}（${RUNTIME_STATES[view.state]}）`,
    `Profile：${view.profileId}`,
    `域：${view.domainLabel}`,
    `引擎：context=${view.engines.context} wakeup=${view.engines.wakeup} toolcall=${view.engines.toolcall}`,
    `模型：${view.model || "未知"}`,
    `创建于：${when(view.createdAt)}，最近活动：${when(view.lastActivity)}`,
  ];
  if (view.activeTurnId !== undefined) lines.push(`活跃轮次：${view.activeTurnId}`);
  if (view.error !== undefined) lines.push(`最近错误：${view.error}`);
  return lines.join("\n");
}

export function formatModelsList(document: ModelsDocument, providerFilter: string | undefined): string {
  const providers = providerFilter === undefined ? document.providers : document.providers.filter((provider) => provider.id === providerFilter);
  if (providers.length === 0 && document.groups.length === 0) return "还没有任何供应商与模型组，使用 ishiki.model.provider.add 添加。";
  const lines = providers.map(
    (provider) =>
      `${provider.id}（${provider.api}${provider.baseUrl === undefined ? "" : ` · ${provider.baseUrl}`}）密钥${secret(provider.apiKey)} · ${provider.models.length} 个模型`,
  );
  const groups = document.groups.map((group) => `模型组 ${group.name}：${group.strategy ?? "failover"} · ${group.models.length} 个成员`);
  return [`供应商共 ${providers.length} 个：`, ...lines, ...(groups.length > 0 ? [`模型组共 ${document.groups.length} 个：`, ...groups] : [])].join("\n");
}

export function formatProviderDetail(provider: ProviderView): string {
  const models = provider.models.map(
    (model) =>
      `  ${model.reference}${model.name === undefined ? "" : `（${model.name}）`}: ${model.type}${model.contextWindow === undefined ? "" : ` · 窗口 ${model.contextWindow}`}`,
  );
  return [
    `供应商 ${provider.id}（${provider.api}）`,
    `baseUrl：${provider.baseUrl ?? "接口默认"}`,
    `密钥：${secret(provider.apiKey)}`,
    `请求头：${Object.keys(provider.headers).length === 0 ? "无" : JSON.stringify(provider.headers)}`,
    `设置：${Object.keys(provider.settings).length === 0 ? "无" : JSON.stringify(provider.settings)}`,
    `模型（${provider.models.length}）：`,
    ...(models.length > 0 ? models : ["  （空）"]),
  ].join("\n");
}

export function formatGroupDetail(group: GroupView): string {
  return [`模型组 ${group.name}`, `策略：${group.strategy ?? "failover"}`, `成员：${group.models.join("、") || "（空）"}`].join("\n");
}

export function formatChannelClaim(view: ChannelClaimView): string {
  const lines = [`频道 ${view.address}`];
  if (view.profileId === undefined) {
    lines.push("归属：没有激活的 Profile 认领");
  } else {
    lines.push(`归属：Profile ${view.profileId}（命中模式 ${view.matchedPattern}）`);
  }
  lines.push(`磁盘认领名单：${view.savedClaimants.join("、") || "无"}`);
  if (view.runtime === undefined) {
    lines.push("Runtime：尚未创建");
  } else {
    lines.push(`Runtime：${view.runtime.id}（${RUNTIME_STATES[view.runtime.state]}）`);
  }
  return lines.join("\n");
}

export function formatChannelList(views: ChannelClaimView[]): string {
  if (views.length === 0) return "没有匹配的频道记录。";
  return views
    .map((view) => {
      const owner = view.profileId ?? "无归属";
      const runtime = view.runtime === undefined ? "无 Runtime" : `${view.runtime.id}（${RUNTIME_STATES[view.runtime.state]}）`;
      return `${view.address} → ${owner} → ${runtime}`;
    })
    .join("\n");
}

export function formatStatusOverview(input: { activeProfiles: string[]; runtimeCounts: Record<RuntimeState, number>; providers: number }): string {
  const counts = (Object.keys(input.runtimeCounts) as RuntimeState[]).map((state) => `${RUNTIME_STATES[state]} ${input.runtimeCounts[state]}`).join(" · ");
  const lines = [
    `激活 Profile：${input.activeProfiles.length}${input.activeProfiles.length > 0 ? `（${input.activeProfiles.join("、")}）` : ""}`,
    `Runtime：${counts}`,
    `网关供应商：${input.providers} 个`,
  ];
  return lines.join("\n");
}

export function formatEnginesDirectory(directory: EnginesDirectory): string {
  return [
    "上下文引擎",
    ...directory.context.map((engine) => `  ${engine.name}（${engine.label}）`),
    "唤醒引擎",
    ...directory.wakeup.map((engine) => `  ${engine.name}（${engine.label}）`),
    "工具调用引擎",
    ...directory.toolcall.map((engine) => `  ${engine.name}（${engine.label}）`),
  ].join("\n");
}

export function formatExtensionsDirectory(directory: ExtensionsDirectory): string {
  if (directory.extensions.length === 0) return "当前没有已加载的扩展。";
  return directory.extensions.map((extension) => `${extension.name}${extension.known ? "" : "（未收录）"}`).join("、");
}

export function formatSessionList(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return "没有匹配的会话。";
  return [
    `会话共 ${sessions.length} 个：`,
    ...sessions.map(
      (session) =>
        `${session.id}：${RUNTIME_STATES[session.state]} · ${session.entries} 条 · ${session.turns} 轮 · ${session.tokens} tokens · 最近活动 ${when(session.lastActivity)}`,
    ),
  ].join("\n");
}

export function formatPersona(text: string): string {
  if (text.length === 0) return "人格文件为空或缺失。";
  return truncate(text, 800);
}
