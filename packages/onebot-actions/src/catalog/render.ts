import { actionsFor, categoriesFor, shapeOf, type LiteAction } from "./index.js";
import type { Backend, CatalogAction, ParamDoc } from "./types.js";

const BACKEND_LABEL: Record<Backend, string> = {
  napcat: "NapCat",
  snowluma: "SnowLuma",
};

function paramType(spec: ParamDoc): string {
  if (spec.type !== undefined) {
    if (spec.type === "array") return "array";
    return spec.type;
  }
  if (spec.anyOf !== undefined) return "any";
  return "any";
}

function paramLine(name: string, spec: ParamDoc, required: boolean): string {
  const bits = [paramType(spec)];
  if (spec.enum !== undefined) bits.push(`取值: ${spec.enum.map((value) => JSON.stringify(value)).join(" / ")}`);
  if (spec.default !== undefined) bits.push(`默认: ${JSON.stringify(spec.default)}`);
  const description = spec.description ?? "";
  const head = `- \`${name}\` (${bits.join("; ")})${required ? " **必填**" : ""}`;
  return description.length > 0 ? `${head} — ${description}` : head;
}

function mediaLine(action: CatalogAction): string | undefined {
  if (action.media === undefined) return undefined;
  const entries = Object.entries(action.media).map(([param, transport]) =>
    transport === "http" ? `\`${param}\` 需要 http(s) URL` : `\`${param}\` 可内联为 base64`,
  );
  return `媒体参数：${entries.join("；")}。资源 URL（asset://、artifact://、local://、workspace:// 等）会自动转换。`;
}

/** 单个动作的完整文档，get_action 与 onebot://actions/<name> 共用。 */
export function renderAction(action: CatalogAction, backend: Backend): string {
  const shape = shapeOf(action, backend);
  const lines: string[] = [`# ${action.name}`, ""];
  if (action.summary.length > 0) lines.push(action.summary, "");
  if (action.description !== undefined) lines.push(action.description, "");

  const wire = action.wire[backend];
  const flags: string[] = [];
  flags.push(`后端: ${action.backends.map((entry) => BACKEND_LABEL[entry]).join(" / ")}`);
  flags.push(action.readOnly[backend] ? "只读" : "有副作用");
  if (wire !== undefined && wire !== action.name) flags.push(`线上名: \`${wire}\``);
  if (action.deprecated === true) flags.push("已废弃");
  if (action.since !== undefined) flags.push(`要求 NapCat ≥ ${action.since}`);
  if (action.aliases.length > 0) flags.push(`别名: ${action.aliases.map((alias) => `\`${alias}\``).join(", ")}`);
  lines.push(flags.join(" · "), "");

  if (shape.required.length > 0) lines.push(`必填参数: ${shape.required.map((name) => `\`${name}\``).join(", ")}`, "");

  const names = Object.keys(shape.params).sort();
  if (names.length > 0) {
    lines.push("## 参数", "");
    for (const name of names) lines.push(paramLine(name, shape.params[name]!, shape.required.includes(name)));
    lines.push("");
  } else {
    lines.push("## 参数", "", "无参数。", "");
  }

  // 另一个后端的独有参数：模型切换 backend 时会遇到，值得一并列出。
  const other: Backend = backend === "napcat" ? "snowluma" : "napcat";
  if (action.backends.includes(other)) {
    const foreign = shapeOf(action, other);
    const only = Object.keys(foreign.params).filter((name) => shape.params[name] === undefined);
    if (only.length > 0) {
      lines.push(`## ${BACKEND_LABEL[other]} 独有参数`, "");
      for (const name of only) lines.push(paramLine(name, foreign.params[name]!, foreign.required.includes(name)));
      lines.push("");
    }
  }

  const media = mediaLine(action);
  if (media !== undefined) lines.push(media, "");
  if (action.deny === true) lines.push(`禁用：该动作不会被执行。${action.note ?? ""}`, "");
  else if (action.note !== undefined) lines.push(`注意：${action.note}`, "");
  return lines.join("\n").trimEnd();
}

/** onebot://actions 的索引：按分类分组，每行一个动作。 */
export function renderIndex(backend: Backend): string {
  const lines: string[] = [
    `# OneBot 动作目录 (${BACKEND_LABEL[backend]})`,
    "",
    `共 ${actionsFor(backend).length} 个动作。详细参数用 onebot://actions/<name>，或调用 get_action。`,
    "",
  ];
  const grouped = new Map<string, CatalogAction[]>();
  for (const action of actionsFor(backend)) {
    const list = grouped.get(action.category);
    if (list === undefined) grouped.set(action.category, [action]);
    else list.push(action);
  }
  for (const { category, count } of categoriesFor(backend)) {
    lines.push(`## ${category} (${count})`, "");
    for (const action of grouped.get(category) ?? []) {
      const marks = [action.readOnly[backend] ? "只读" : "写", ...(action.deny === true ? ["禁用"] : [])].join("/");
      lines.push(`- \`${action.name}\` [${marks}] ${action.summary}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function liteOf(action: CatalogAction, backend: Backend): LiteAction {
  return {
    name: action.name,
    aliases: action.aliases,
    category: action.category,
    summary: action.summary,
    readOnly: action.readOnly[backend],
    ...(action.deprecated === true ? { deprecated: true } : {}),
    ...(action.deny === true ? { deny: true } : {}),
  };
}
