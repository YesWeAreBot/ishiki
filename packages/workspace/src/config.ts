import { Schema } from "koishi";

/**
 * profile.yaml 里 `extends.workspace.config` 的内容：字段含义由本包解释，核心原样递进来。
 * 单层配置，没有 preset/scene 那样的逐层合并，所以缺省值就写在这里一份，控制台看到的即生效值。
 */
export interface WorkspaceConfig {
  /** 沙箱内的初始工作目录。 */
  cwd: string;
  /** 单条命令的总时限（毫秒）。 */
  timeoutMs: number;
  /** stdout 与 stderr 各自的上限（字符）。 */
  maxOutputLength: number;
  /** 是否允许沙箱内访问网络。 */
  network: boolean;
  /** 是否启用 `js-exec`（QuickJS 里跑 JavaScript / TypeScript）。 */
  javascript: boolean;
  /** 是否启用 `python3` / `python`（CPython 编译成 WebAssembly）。 */
  python: boolean;
  /** 额外的技能目录，相对 profile 目录解析。 */
  skills: string[];
  /** 宿主目录挂载声明。 */
  mounts: string[];
}

export const WorkspaceConfig: Schema<WorkspaceConfig> = Schema.object({
  cwd: Schema.string().description("沙箱内的初始工作目录；应当是某个挂载点覆盖得到的虚拟路径").default("/home/workspace"),
  timeoutMs: Schema.number().description("单条命令的总时限（毫秒），超时按退出码 124 返回").default(30_000),
  maxOutputLength: Schema.number().description("bash 的 stdout 与 stderr 各自的上限（字符），超出截断").default(30_000),
  network: Schema.boolean().description("允许沙箱内访问网络；开启时仍拒绝私有地址").default(false),
  javascript: Schema.boolean().description("启用 js-exec 命令（QuickJS 里执行 JavaScript / TypeScript）；默认关闭，开它会多一份代码执行面").default(false),
  python: Schema.boolean().description("启用 python3 / python 命令（CPython 编译成 WebAssembly）；默认关闭，开它会多一份代码执行面").default(false),
  skills: Schema.array(Schema.string()).description("额外技能目录，相对 profile 目录解析；与数据根的 skills 目录合并，同名以这里优先").default([]),
  mounts: Schema.array(Schema.string()).description("宿主目录挂载，写法 `source:target[:ro]`；source 相对 profile 目录解析，省略 :ro 即可读写").default([]),
});

/** 解析 profile 递给本包的 config；写错就抛，由内核在这一实例诞生时报出来。 */
export function parseWorkspaceConfig(raw: unknown): WorkspaceConfig {
  // Schema 的入参类型就是解析结果本身；缺省值由它补上，原始值在这里断言。
  return WorkspaceConfig((raw ?? {}) as WorkspaceConfig);
}
