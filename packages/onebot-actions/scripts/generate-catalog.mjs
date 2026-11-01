#!/usr/bin/env node
// 从 NapCat、SnowLuma 与 LLBot 的 OpenAPI 文档生成 src/catalog/generated.ts。
// 生成物提交进仓库：运行时与构建都不依赖参考仓库。
//
// 用法：
//   node scripts/generate-catalog.mjs
//   node scripts/generate-catalog.mjs --check
// 参考仓库位置由环境变量覆盖：
//   NAPCAT_DOCS   NapCatDocs 仓库根目录
//   SNOWLUMA_DOCS SnowLumaDocs 仓库根目录
//   LLBOT_DOCS    LLBot OpenAPI 导出（openapi.json）所在目录

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, "../src/catalog/generated.ts");

const NAPCAT = process.env.NAPCAT_DOCS ?? "D:/Codespace/references/NapCatDocs";
const SNOWLUMA = process.env.SNOWLUMA_DOCS ?? "D:/Codespace/references/SnowLumaDocs";
const LLBOT = process.env.LLBOT_DOCS ?? "D:/Codespace/references/LLBotDocs";

const NAPCAT_API = path.join(NAPCAT, "src/api");
const SNOWLUMA_API = path.join(SNOWLUMA, "public/openapi/snowluma.json");
const SNOWLUMA_CATALOG = path.join(SNOWLUMA, "docs/public/api/catalog.json");
const LLBOT_API = path.join(LLBOT, "openapi.json");

/** 后端固定顺序；共有参数的规格按 SPEC_PRIORITY 取。 */
const BACKENDS = ["napcat", "snowluma", "llbot"];
const SPEC_PRIORITY = ["snowluma", "napcat", "llbot"];

/** 分类归一：SnowLuma 的分类词表是策划过的，优先采用；其余按 tag 映射。 */
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

/** LLBot 的导出把 OneBot 11 与 Milky 放在同一份文档里，tag 的第二段就是它的分组。 */
const LLBOT_ONEBOT_TAG = /^OneBot 11\//;
const LLBOT_CATEGORY = {
  用户: "好友",
  群组: "群管理",
  消息: "消息",
  文件: "群文件",
  系统: "系统",
  其他: "扩展",
};

const CATEGORY_ORDER = ["消息", "好友", "群信息", "群管理", "群文件", "请求", "群相册", "QQ 空间", "系统表情", "流式接口", "系统", "扩展"];

/** 算法无法判定、或不同后端叫法不同需要合并的动作。 */
const OVERRIDES = {
  ArkSharePeer: { aliasOf: "share_peer" },
  ArkShareGroup: { aliasOf: "share_group_ex" },
  upload_foward_msg: { aliasOf: "upload_forward_msg" },
  get_group_ignore_add_request: { aliasOf: "get_group_ignored_notifies" },
  ".ocr_image": { aliasOf: "ocr_image" },
  // LLBot 的线上名与规范名不同，或与已有动作是同一能力。
  _delete_group_notice: { aliasOf: "_del_group_notice" },
  voice_msg_to_text: { aliasOf: "fetch_ptt_text" },
  set_friend_category: { aliasOf: "set_friends_category" },
  send_pb: { aliasOf: "send_packet" },
  upload_group_album: { aliasOf: "upload_images_to_qun_album" },
  // NapCat 按 tag 归到群管理，实际属于群相册。
  upload_images_to_qun_album: { category: "群相册" },
  create_group_album: { category: "群相册" },
  delete_group_album: { category: "群相册" },
  // NapCat 没有可用的只读标记，按名称前缀推断会误判这几个。
  get_ai_record: { readOnly: { napcat: false }, note: "传入文本生成语音并上传，会在群里产生一条语音消息。" },
  _mark_all_as_read: { readOnly: { napcat: false } },
  request_decrypt_key: { readOnly: { napcat: false }, note: "读取数据库解密密钥，属于本机敏感信息。" },
  translate_en2zh: { readOnly: { napcat: true } },
  send_ark_share: { readOnly: { napcat: true } },
  send_group_ark_share: { readOnly: { napcat: true } },
  fetch_ptt_text: { readOnly: { llbot: true } },
  get_cookies: { readOnly: { napcat: true }, deny: true, note: "返回账号 Cookie；默认禁用。" },
  get_credentials: { readOnly: { napcat: true }, deny: true, note: "返回账号登录凭证；默认禁用。" },
  get_csrf_token: { readOnly: { napcat: true }, deny: true, note: "返回账号 CSRF 令牌；默认禁用。" },
  send_packet: { deny: true, note: "发送原始 SSO 包，可直接触发任意协议操作。" },
  set_restart: { deny: true, note: "重启协议端，会中断全部会话。" },
  bot_exit: { deny: true, note: "退出机器人账号，需要人工重新登录。" },
  ocr_image: {
    readOnly: { napcat: true, llbot: true },
    media: { image: "http" },
    note: "SnowLuma 只接受 http(s) URL 或已缓存的 file_id；NapCat 与 LLBot 还接受本地路径和 base64。",
  },
  set_qq_avatar: { media: { file: "inline" } },
  set_group_portrait: { media: { file: "inline" } },
  send_tuwen_ark: { media: { preview_url: "http" } },
  get_mini_app_ark: { media: { picUrl: "http", pic_url: "http" } },
  download_file: { media: { url: "http" } },
  upload_group_file: { media: { file: "inline" } },
  upload_private_file: { media: { file: "inline" } },
  add_custom_face: { media: { file: "inline" } },
  upload_flash_file: { media: { paths: "inline" } },
  scan_qrcode: { media: { file: "inline" } },
};

/** 只读判定只用于没有 override 的动作。 */
const READ_ONLY_PREFIX = /^(get_|can_|fetch_|check_|search_|list_|nc_get_|_get_|_mark_)/;

/** 导出里混进来的 Apifox 占位键，既不是参数也不是必填项。 */
const PLACEHOLDER_KEY = /^[0-9A-Z]{20,26}$/;

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

function llbotCategory(tag) {
  return LLBOT_CATEGORY[tag.split("/")[2]] ?? "扩展";
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

function actionsOf(document, { methods = ["post"], filter } = {}) {
  const out = new Map();
  for (const [raw, item] of Object.entries(document.paths)) {
    const method = methods.find((entry) => item[entry] !== undefined);
    if (method === undefined) continue;
    const operation = item[method];
    if (filter !== undefined && !filter(operation, raw)) continue;
    const schema = operation.requestBody?.content?.["application/json"]?.schema ?? { properties: {} };
    const params = {};
    for (const [name, spec] of Object.entries(schema.properties ?? {})) {
      if (PLACEHOLDER_KEY.test(name)) continue;
      params[name] = mergeSchema(spec);
    }
    out.set(raw.slice(1), {
      summary: operation.summary ?? "",
      description: operation.description === undefined ? undefined : operation.description.replace(/\s+/g, " ").trim() || undefined,
      tags: operation.tags ?? [],
      deprecated: operation.deprecated === true,
      params,
      // 声明了 default 的参数由服务端补值，OpenAPI 仍可能把它列进 required；
      // 这种「必填」不代表调用方必须提供，按可选处理。占位键同理。
      required: [...(schema.required ?? [])].filter((name) => params[name] !== undefined && params[name].default === undefined).sort(),
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

function loadLlbot() {
  const document = JSON.parse(fs.readFileSync(LLBOT_API, "utf8"));
  const actions = actionsOf(document, {
    methods: ["post", "get"],
    // `_events` 是接收事件的 SSE 长连接，不是可调用动作。
    filter: (operation, raw) => raw !== "/_events" && (operation.tags ?? []).some((tag) => LLBOT_ONEBOT_TAG.test(tag)),
  });
  for (const action of actions.values()) {
    action.category = llbotCategory(action.tags.find((tag) => LLBOT_ONEBOT_TAG.test(tag)));
  }
  return actions;
}

/** 分类优先级：SnowLuma 的策划词表 > NapCat 的 tag > LLBot 的 tag。 */
function categoryOf(entries) {
  const snow = entries.get("snowluma");
  if (snow !== undefined) return snow.action.category;
  const nap = entries.get("napcat");
  if (nap !== undefined) return normalizeCategory(nap.action.tags[0] ?? "");
  return entries.get("llbot").action.category;
}

function mergeAll() {
  const backends = { napcat: loadNapcat(), snowluma: loadSnowluma(), llbot: loadLlbot() };

  // 别名折叠：别名指向一个规范名。线上名字各后端不同，所以每个后端还要记住
  // 自己的实际动作名（wire name），执行时按它发送。
  const aliasTo = new Map();
  for (const [name, rules] of Object.entries(OVERRIDES)) {
    if (rules.aliasOf !== undefined) aliasTo.set(name, rules.aliasOf);
  }
  for (const [name, action] of backends.snowluma) {
    for (const alias of action.aliases ?? []) {
      if (alias.startsWith(".") || aliasTo.has(alias)) continue;
      aliasTo.set(alias, name);
    }
  }

  // 每个后端一张 canonical → { action, wire, aliases } 表，别名在这里被吸收。
  const tables = {};
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
    tables[backend] = table;
  }

  const names = new Set();
  for (const backend of BACKENDS) for (const name of tables[backend].keys()) names.add(name);

  const actions = [];
  for (const name of names) {
    const present = BACKENDS.filter((backend) => tables[backend].has(name));
    const entries = new Map(present.map((backend) => [backend, tables[backend].get(name)]));
    const rules = OVERRIDES[name] ?? {};
    const firstDescription = present.map((backend) => entries.get(backend).action.description).find((value) => value !== undefined);
    const summary = present.map((backend) => entries.get(backend).action.summary).find((value) => value.length > 0) ?? "";

    const merged = {
      name,
      category: rules.category ?? categoryOf(entries),
      summary,
      ...(firstDescription !== undefined ? { description: firstDescription } : {}),
      backends: present,
      wire: Object.fromEntries(present.map((backend) => [backend, entries.get(backend).wire])),
      readOnly: Object.fromEntries(
        BACKENDS.map((backend) => {
          const entry = entries.get(backend);
          if (entry === undefined) return [backend, false];
          // SnowLuma 的 OpenAPI 没有只读标记，取它 catalog.json 里的说法；其余按名称前缀推断。
          const inferred = backend === "snowluma" ? entry.action.readOnly === true : isReadOnlyName(entry.wire);
          return [backend, readOnlyOf(rules, backend, inferred)];
        }),
      ),
      aliases: [...new Set(present.flatMap((backend) => entries.get(backend).aliases))].sort(),
      params: {},
      required: [],
      ...(entries.has("napcat") && entries.get("napcat").action.since !== undefined ? { since: entries.get("napcat").action.since } : {}),
      ...(present.some((backend) => entries.get(backend).action.deprecated === true) ? { deprecated: true } : {}),
      ...(rules.deny === true ? { deny: true } : {}),
      ...(rules.note !== undefined ? { note: rules.note } : {}),
      ...(rules.media !== undefined ? { media: rules.media } : {}),
    };

    if (present.length === 1) {
      const only = entries.get(present[0]).action;
      merged.params = stable(only.params);
      merged.required = [...only.required];
      actions.push(merged);
      continue;
    }

    // 各后端都有的参数进公共部分；只属于部分后端的进它自己的变体。
    // 这样 shapeOf(action, backend) 得到的正是该后端真正接受的参数集合。
    const specOrder = SPEC_PRIORITY.filter((backend) => entries.has(backend));
    const shared = {};
    const spec = entries.get(specOrder[0]).action.params;
    for (const param of Object.keys(spec)) {
      if (specOrder.every((backend) => entries.get(backend).action.params[param] !== undefined)) shared[param] = spec[param];
    }
    merged.params = stable(shared);
    merged.required = entries
      .get(specOrder[0])
      .action.required.filter((param) => specOrder.every((backend) => entries.get(backend).action.required.includes(param)));

    const variants = {};
    for (const backend of BACKENDS) {
      if (!entries.has(backend)) continue;
      const own = entries.get(backend).action;
      const params = {};
      for (const [param, value] of Object.entries(own.params)) {
        if (shared[param] !== undefined) continue;
        // 规格取拥有该参数、且在 SPEC_PRIORITY 里最靠前的后端，
        // 这样两个旧后端共有的参数不会因为 LLBot 缺席而换用较低优先级的描述。
        const source = SPEC_PRIORITY.find((candidate) => entries.get(candidate)?.action.params[param] !== undefined);
        params[param] = source === undefined ? value : entries.get(source).action.params[param];
      }
      const required = own.required.filter((param) => !merged.required.includes(param));
      if (Object.keys(params).length === 0 && required.length === 0) continue;
      variants[backend] = stable({ ...(Object.keys(params).length > 0 ? { params } : {}), ...(required.length > 0 ? { required } : {}) });
    }

    actions.push({ ...merged, ...(Object.keys(variants).length > 0 ? { variants } : {}) });
  }

  actions.sort((a, b) => a.name.localeCompare(b.name));
  return actions;
}

function render(actions) {
  const lines = [];
  lines.push("// 由 scripts/generate-catalog.mjs 从 NapCat、SnowLuma 与 LLBot 的 OpenAPI 文档生成，请勿手工编辑。");
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
