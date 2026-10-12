import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: "export",
  // 静态托管不会把 /docs/quickstart 映射到 docs/quickstart.html，
  // 打开这个开关让每条路由都导出成 xxx/index.html。
  trailingSlash: true,
  reactStrictMode: true,
};

export default withMDX(config);
