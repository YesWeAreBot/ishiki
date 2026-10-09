import { Schema } from "koishi";

export interface WorkspaceConfig {
  cwd: string;
  timeoutMs: number;
  maxExecutionOutputBytes: number;
  network: boolean;
  javascript: boolean;
  python: boolean;
  skills: string[];
  mounts: string[];
}

export const WorkspaceConfig: Schema<WorkspaceConfig> = Schema.object({
  cwd: Schema.string().description("沙箱内的初始工作目录；应当是某个挂载点覆盖得到的虚拟路径").default("/home/workspace"),
  timeoutMs: Schema.number().description("单条命令的总时限（毫秒），超时按退出码 124 返回").default(30_000),
  maxExecutionOutputBytes: Schema.number()
    .min(1)
    .description("执行器输出安全上限；模型可见预览由 Ishiki 统一处理")
    .default(32 * 1024 * 1024),
  network: Schema.boolean().description("允许沙箱内访问网络；开启时仍拒绝私有地址").default(false),
  javascript: Schema.boolean().description("启用 js-exec 命令（QuickJS 里执行 JavaScript / TypeScript）；默认关闭，开它会多一份代码执行面").default(false),
  python: Schema.boolean().description("启用 python3 / python 命令（CPython 编译成 WebAssembly）；默认关闭，开它会多一份代码执行面").default(false),
  skills: Schema.array(Schema.string()).description("额外技能目录，相对 profile 目录解析；与数据根的 skills 目录合并，同名以这里优先").default([]),
  mounts: Schema.array(Schema.string()).description("宿主目录挂载，写法 `source:target[:ro]`；source 相对 profile 目录解析，省略 :ro 即可读写").default([]),
});
