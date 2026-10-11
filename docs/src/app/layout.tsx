import type { Metadata } from "next";
import { Inter } from "next/font/google";

import { Provider } from "@/components/provider";
import { appName } from "@/lib/shared";

import "./global.css";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // 静态导出的 OG 图等绝对地址以此为准，与 next.config.mjs 的 basePath 保持一致
  // TODO: ishiki.js.org 生效后改为该域名
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://yeswearebot.github.io/ishiki"),
  title: {
    default: appName,
    template: `%s | ${appName}`,
  },
  description: "Ishiki（意识）是事件驱动的 Koishi 群聊人格运行时：让大语言模型以「一个真实的人」的方式生活在群聊与私聊里。",
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
