#!/usr/bin/env node
// 从 NapCat 与 SnowLuma 的 OpenAPI 文档生成 src/catalog/generated.ts。
// 生成物提交进仓库：运行时与构建都不依赖参考仓库。
//
// 用法：
//   node scripts/generate-catalog.mjs
//   node scripts/generate-catalog.mjs --check
// 参考仓库位置由环境变量覆盖：
//   NAPCAT_DOCS  NapCatDocs 仓库根目录
//   SNOWLUMA_DOCS SnowLumaDocs 仓库根目录

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, "../src/catalog/generated.ts");

const NAPCAT = process.env.NAPCAT_DOCS ?? "D:/Codespace/references/NapCatDocs";
const SNOWLUMA = process.env.SNOWLUMA_DOCS ?? "D:/Codespace/references/SnowLumaDocs";

const NAPCAT_API = path.join(NAPCAT, "src/api");
const SNOWLUMA_API = path.join(SNOWLUMA, "public/openapi/snowluma.json");
const SNOWLUMA_CATALOG = path.join(SNOWLUMA, "docs/public/api/catalog.json");

/** 分类归一：SnowLuma 的分类词表是策划过的，优先采用；NapCat 独有动作按 tag 映射。 */
const CATEGORY_BY_TAG = {
  消息接口: "消息",
  消息扩展: "消息",
  用户接口: "好友",
  用户扩展: "好友",
  群组接口: "群信息",
  核心接口: "群信息",
  群组扩展: "群管理",
  文件接口: "群文件",
  文件扩展: "群文件",
  流式接口: "流式接口",
  流式传输扩展: "流式接口",
  系统接口: "系统",
  系统扩展: "系统",
  扩展接口: "扩展",
  频道接口: "扩展",
  "AI 扩展": "扩展",
  "Go-CQHTTP": "扩展",
};

const SNOWLUMA_CATEGORY = {
  信息: "系统",
  消息: "消息",
  好友: "好友",
  群信息: "群信息",
  群管理: "群管理",
  群文件: "群文件",
  请求: "请求",
  扩展: "扩展",
  群相册: "群相册",
  空间: "QQ 空间",
  系统表情: "系统表情",
  流式接口: "流式接口",
};

const CATEGORY_ORDER = ["消息", "好友", "群信息", "群管理", "群文件", "请求", "群相册", "QQ 空间", "系统表情", "流式接口", "系统", "扩展"];

/** 算法无法判定、或两边叫法不同需要合并的动作。 */
const OVERRIDES = {
  ArkSharePeer: { aliasOf: "share_peer" },
  ArkShareGroup: { aliasOf: "share_group_ex" },
  upload_foward_msg: { aliasOf: "upload_forward_msg" },
  get_group_ignore_add_request: { aliasOf: "get_group_ignored_notifies" },
  ".ocr_image": { aliasOf: "ocr_image" },
  // NapCat 没有可用的只读标记，按名称前缀推断会误判这几个。
  get_ai_record: { readOnly: { napcat: false }, note: "传入文本生成语音并上传，会在群里产生一条语音消息。" },
  _mark_all_as_read: { readOnly: { napcat: false } },
  request_decrypt_key: { readOnly: { napcat: false }, note: "读取数据库解密密钥，属于本机敏感信息。" },
  translate_en2zh: { readOnly: { napcat: true } },
  send_ark_share: { readOnly: { napcat: true } },
  send_group_ark_share: { readOnly: { napcat: true } },
  get_cookies: { readOnly: { napcat: true }, deny: true, note: "返回账号 Cookie；默认禁用。" },
  get_credentials: { readOnly: { napcat: true }, deny: true, note: "返回账号登录凭证；默认禁用。" },
  get_csrf_token: { readOnly: { napcat: true }, deny: true, note: "返回账号 CSRF 令牌；默认禁用。" },
  send_packet: { deny: true, note: "发送原始 SSO 包，可直接触发任意协议操作。" },
  set_restart: { deny: true, note: "重启协议端，会中断全部会话。" },
  bot_exit: { deny: true, note: "退出机器人账号，需要人工重新登录。" },
  ocr_image: { readOnly: { napcat: true }, media: { image: "http" }, note: "SnowLuma 只接受 http(s) URL 或已缓存的 file_id；NapCat 还接受本地路径和 base64。" },
  set_qq_avatar: { media: { file: "inline" } },
  set_group_portrait: { media: { file: "inline" } },
  send_tuwen_ark: { media: { preview_url: "http" } },
  get_mini_app_ark: { media: { picUrl: "http", pic_url: "http" } },
  download_file: { media: { url: "http" } },
  upload_group_file: { media: { file: "inline" } },
  upload_private_file: { media: { file: "inline" } },
  add_custom_face: { media: { file: "inline" } },
};

/** 只读判定只用于没有 override 的动作。 */
const READ_ONLY_PREFIX = /^(get_|can_|fetch_|check_|search_|list_|nc_get_|_get_|_mark_)/;

function isReadOnlyName(name) {
  if (!READ_ONLY_PREFIX.test(name)) return false;
  return true;
}

function normalizeCategory(tag) {
  return CATEGORY_BY_TAG[tag] ?? "扩展";
}

function snowlumaCategory(category) {
  return SNOWLUMA_CATEGORY[category] ?? "扩展";
}

function readOnlyOf(rules, backend, inferred) {
  const override = rules.readOnly;
  if (override === undefined) return inferred;
  if (typeof override === "boolean") return override;
  return override[backend] ?? inferred;
}

/** 深度排序对象键，保证生成结果稳定。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

function mergeSchema(schema) {
  return stable({
    type: schema.type,
    description: schema.description,
    enum: schema.enum,
    default: schema.default,
    minimum: schema.minimum,
    maximum: schema.maximum,
    items: schema.items,
    anyOf: schema.anyOf,
    oneOf: schema.oneOf,
  });
}

function readVersion(version) {
  const file = path.join(NAPCAT_API, version, "openapi.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listNapcatVersions() {
  return fs
    .readdirSync(NAPCAT_API)
    .filter((name) => fs.existsSync(path.join(NAPCAT_API, name, "openapi.json")))
    .map((name) => ({ name, parts: name.split(".").map(Number) }))
    .sort((a, b) => {
      for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
        const delta = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
        if (delta !== 0) return delta;
      }
      return 0;
    })
    .map((entry) => entry.name);
}

function actionsOf(document) {
  const out = new Map();
  for (const [raw, item] of Object.entries(document.paths)) {
    const post = item.post;
    if (!post) continue;
    const schema = post.requestBody?.content?.["application/json"]?.schema ?? { properties: {} };
    const params = {};
    for (const [name, spec] of Object.entries(schema.properties ?? {})) params[name] = mergeSchema(spec);
    out.set(raw.slice(1), {
      summary: post.summary ?? "",
      description: post.description === undefined ? undefined : post.description.replace(/\s+/g, " ").trim() || undefined,
      tags: post.tags ?? [],
      deprecated: post.deprecated === true,
      params,
      // 声明了 default 的参数由服务端补值，OpenAPI 仍可能把它列进 required；
      // 这种「必填」不代表调用方必须提供，按可选处理。
      required: [...(schema.required ?? [])].filter((name) => params[name]?.default === undefined).sort(),
    });
  }
  return out;
}

function loadNapcat() {
  const versions = listNapcatVersions();
  const latest = versions.at(-1);
  const document = readVersion(latest);
  const actions = actionsOf(document);

  // 每个动作首次出现的版本：4.12.0 是文档起点，不能证明更早不存在。
  const seen = new Map();
  for (const version of versions) {
    for (const name of actionsOf(readVersion(version)).keys()) {
      if (!seen.has(name)) seen.set(name, version);
    }
  }
  for (const [name, version] of seen) {
    if (version === versions[0]) continue;
    const action = actions.get(name);
    if (action !== undefined) action.since = version;
  }
  return actions;
}

function loadSnowluma() {
  const document = JSON.parse(fs.readFileSync(SNOWLUMA_API, "utf8"));
  const catalog = JSON.parse(fs.readFileSync(SNOWLUMA_CATALOG, "utf8"));
  const actions = actionsOf(document);
  const meta = new Map(catalog.actions.map((action) => [action.name, action]));

  for (const [name, action] of actions) {
    const entry = meta.get(name);
    if (entry === undefined) continue;
    action.readOnly = entry.readOnly === true;
    action.aliases = [...(entry.aliases ?? [])].sort();
    action.category = snowlumaCategory(entry.category);
  }
  return actions;
}

function mergeAll() {
  const napcat = loadNapcat();
  const snowluma = loadSnowluma();
  const backends = { napcat, snowluma };

  // 别名折叠：别名指向一个规范名。`share_peer` 在 NapCat 上叫 `ArkSharePeer`，
  // 所以每个后端还要记住自己的实际动作名（wire name），执行时按它发送。
  const aliasTo = new Map();
  for (const [name, rules] of Object.entries(OVERRIDES)) {
    if (rules.aliasOf !== undefined) aliasTo.set(name, rules.aliasOf);
  }
  for (const [name, action] of snowluma) {
    for (const alias of action.aliases ?? []) {
      if (alias.startsWith(".") || aliasTo.has(alias)) continue;
      aliasTo.set(alias, name);
    }
  }

  // 每个后端一张 canonical → { action, wire, aliases } 表，别名在这里被吸收。
  const perBackend = {};
  for (const [backend, actions] of Object.entries(backends)) {
    const table = new Map();
    for (const [name, action] of actions) {
      const canonical = aliasTo.get(name) ?? name;
      const existing = table.get(canonical);
      if (existing === undefined) {
        table.set(canonical, { action, wire: name, aliases: name === canonical ? [] : [name] });
        continue;
      }
      // 规范名本身也有实现时以它为准，只把别名记在规范名下。
      if (name === canonical)
        table.set(canonical, { action, wire: name, aliases: [...existing.aliases, ...(existing.wire === canonical ? [] : [existing.wire])] });
      else existing.aliases.push(name);
    }
    perBackend[backend] = table;
  }

  const names = new Set([...perBackend.napcat.keys(), ...perBackend.snowluma.keys()]);
  const actions = [];
  for (const name of names) {
    const nap = perBackend.napcat.get(name);
    const snow = perBackend.snowluma.get(name);
    const rules = OVERRIDES[name] ?? {};
    const wire = {};
    if (nap !== undefined) wire.napcat = nap.wire;
    if (snow !== undefined) wire.snowluma = snow.wire;

    const merged = {
      name,
      category: snow?.action.category ?? normalizeCategory(nap?.action.tags[0] ?? ""),
      summary: nap?.action.summary || snow?.action.summary || "",
      ...((nap?.action.description ?? snow?.action.description) ? { description: nap?.action.description ?? snow?.action.description } : {}),
      backends: [...(nap ? ["napcat"] : []), ...(snow ? ["snowluma"] : [])],
      wire,
      readOnly: {
        napcat: nap ? readOnlyOf(rules, "napcat", isReadOnlyName(nap.wire)) : false,
        snowluma: snow ? readOnlyOf(rules, "snowluma", snow.action.readOnly === true) : false,
      },
      aliases: [...new Set([...(nap?.aliases ?? []), ...(snow?.aliases ?? [])])].sort(),
      params: {},
      required: [],
      ...(nap?.action.since !== undefined ? { since: nap.action.since } : {}),
      ...(nap?.action.deprecated === true || snow?.action.deprecated === true ? { deprecated: true } : {}),
      ...(rules.deny === true ? { deny: true } : {}),
      ...(rules.note !== undefined ? { note: rules.note } : {}),
      ...(rules.media !== undefined ? { media: rules.media } : {}),
    };

    if (nap === undefined || snow === undefined) {
      const only = (nap ?? snow).action;
      merged.params = stable(only.params);
      merged.required = [...only.required];
      actions.push(merged);
      continue;
    }

    const napAction = nap.action;
    const snowAction = snow.action;
    // 两边都有的参数进公共部分；只属于一个后端的进它自己的变体。
    // 这样 shapeOf(action, backend) 得到的正是该后端真正接受的参数集合。
    const shared = {};
    for (const param of Object.keys(napAction.params)) {
      if (snowAction.params[param] !== undefined) shared[param] = snowAction.params[param];
    }
    merged.params = stable(shared);
    merged.required = napAction.required.filter((param) => snowAction.required.includes(param));

    const variants = {};
    const variantOf = (backend, own, foreign) => {
      const params = {};
      for (const [param, spec] of Object.entries(own.params)) if (foreign.params[param] === undefined) params[param] = spec;
      const required = own.required.filter((param) => !merged.required.includes(param));
      if (Object.keys(params).length === 0 && required.length === 0) return;
      variants[backend] = stable({ ...(Object.keys(params).length > 0 ? { params } : {}), ...(required.length > 0 ? { required } : {}) });
    };
    variantOf("napcat", napAction, snowAction);
    variantOf("snowluma", snowAction, napAction);

    actions.push({ ...merged, ...(Object.keys(variants).length > 0 ? { variants } : {}) });
  }

  actions.sort((a, b) => a.name.localeCompare(b.name));
  return actions;
}

function render(actions) {
  const lines = [];
  lines.push("// 由 scripts/generate-catalog.mjs 从 NapCat 与 SnowLuma 的 OpenAPI 文档生成，请勿手工编辑。");
  lines.push("// 重新生成：node scripts/generate-catalog.mjs（--check 只校验不写入）");
  lines.push("");
  lines.push('import type { CatalogAction } from "./types.js";');
  lines.push("");
  lines.push(`export const CATEGORIES = ${JSON.stringify(CATEGORY_ORDER)} as const;`);
  lines.push("");
  lines.push("export const ACTIONS: readonly CatalogAction[] = [");
  for (const action of actions) lines.push(`  ${JSON.stringify(action)},`);
  lines.push("];");
  lines.push("");
  return lines.join("\n");
}

const actions = mergeAll();
const content = render(actions);

if (process.argv.includes("--check")) {
  const existing = fs.existsSync(output) ? fs.readFileSync(output, "utf8") : "";
  if (existing !== content) {
    console.error(`catalog is stale: ${output}`);
    process.exit(1);
  }
  console.log(`catalog up to date: ${actions.length} actions`);
} else {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, content);
  console.log(`wrote ${actions.length} actions to ${output}`);
}
