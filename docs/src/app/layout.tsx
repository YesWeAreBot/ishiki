import type { Metadata } from "next";
import { Inter } from "next/font/google";

import { Provider } from "@/components/provider";
import { appName } from "@/lib/shared";

import "./global.css";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // 静态导出的 OG 图等绝对地址以此为准，与部署域名保持一致
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://ishiki.js.org"),
  title: {
    default: appName,
    template: `%s | ${appName}`,
  },
  description: "Ishiki（意识）是用于构建自主 Agent 的 Bot 开发元框架：上下文、唤醒与工具调用三族引擎可替换，提供工具编程、按需发现、统一资源访问与多实例运行。",
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
