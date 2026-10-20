import Link from "next/link";

import { appName } from "@/lib/shared";

const slogan = "为意识赋形，让 Agent 自成一格。";

const sections = [
  {
    href: "/docs/tutorial/quickstart",
    label: "教程",
    description: "从源码构建到第一次对话，跟着做就能跑起来",
  },
  {
    href: "/docs/guides/profile",
    label: "指南",
    description: "模型、人设、唤醒、上下文、MCP 与工作区：按目标查找配置方法",
  },
  {
    href: "/docs/reference/plugin-config",
    label: "参考",
    description: "配置项、models.yaml、内置工具、扩展 API 与数据目录",
  },
  {
    href: "/docs/explanations/architecture",
    label: "解析",
    description: "分层、模块依赖、三族引擎与 profile 的运行方式",
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center gap-12 px-6 py-16 text-center">
      <div className="space-y-4">
        <h1 className="text-4xl font-bold tracking-tight">{appName} · 意识</h1>
        <p className="text-lg font-medium">{slogan}</p>
        <p className="mx-auto max-w-2xl text-lg text-fd-muted-foreground">
          用于构建自主 Agent 的 Bot 开发元框架。通过三族可替换引擎塑造上下文、模型交互与运行节律，使用工具编程、统一资源与多实例部署拓展能力。
        </p>
        <p className="text-sm text-fd-muted-foreground">
          当前以 <code className="rounded bg-fd-muted px-1.5 py-0.5">koishi-plugin-ishiki</code> 运行于 Koishi。
        </p>
      </div>

      <div className="flex flex-wrap justify-center gap-3">
        <Link href="/docs" className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90">
          阅读文档
        </Link>
        <Link href="/docs/tutorial/quickstart" className="rounded-lg border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent">
          快速开始
        </Link>
      </div>

      <div className="grid w-full gap-3 sm:grid-cols-2">
        {sections.map((section) => (
          <Link key={section.href} href={section.href} className="rounded-xl border bg-fd-card p-5 text-start transition-colors hover:bg-fd-accent">
            <div className="font-medium text-fd-card-foreground">{section.label}</div>
            <div className="mt-1 text-sm text-fd-muted-foreground">{section.description}</div>
          </Link>
        ))}
      </div>

    </main>
  );
}
