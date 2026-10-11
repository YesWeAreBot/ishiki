import Link from "next/link";

import { appName } from "@/lib/shared";

const sections = [
  {
    href: "/docs/tutorial/quickstart",
    label: "教程",
    description: "从源码构建到第一句对话，跟着做就能跑起来",
  },
  {
    href: "/docs/guides/models",
    label: "指南",
    description: "模型、人设、唤醒、上下文、MCP、工作区的一线用法",
  },
  {
    href: "/docs/reference/plugin-config",
    label: "参考",
    description: "配置项、models.yaml、内置工具、mcp.json、数据目录",
  },
  {
    href: "/docs/explanations/architecture",
    label: "解析",
    description: "为什么这样设计：引擎族、profile 与 runtime、工具流水线",
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center gap-12 px-6 py-16 text-center">
      <div className="space-y-4">
        <h1 className="text-4xl font-bold">{appName}</h1>
        <p className="mx-auto max-w-2xl text-lg text-fd-muted-foreground">
          事件驱动的 Koishi 群聊人格运行时。它按事件醒来、自行决定要不要说话、能调用工具做事，并始终以你写的人格存在。
        </p>
      </div>

      <div className="flex flex-wrap justify-center gap-3">
        <Link href="/docs" className="rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90">
          阅读文档
        </Link>
        <Link href="/docs/tutorial/quickstart" className="rounded-lg border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent">
          快速上手
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
