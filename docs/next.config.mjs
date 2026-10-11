import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: "export",
  // GitHub Pages 的项目页在 https://yeswearebot.github.io/ishiki/ 下提供服务，
  // 静态导出的资源引用必须带上这段前缀。
  // TODO: ishiki.js.org 生效后站点改由域名根路径提供服务，届时删掉这一行。
  basePath: "/ishiki",
  // 静态托管不会把 /docs/quickstart 映射到 docs/quickstart.html，
  // 打开这个开关让每条路由都导出成 xxx/index.html。
  trailingSlash: true,
  reactStrictMode: true,
};

export default withMDX(config);
