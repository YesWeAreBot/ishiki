import { remarkMdxFiles, remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { defineConfig } from "fumadocs-mdx/config";

export default defineConfig({
  mdxOptions: {
    // ```mermaid 围栏 → <Mermaid />，```files 围栏 → <Files />
    remarkPlugins: [remarkMdxMermaid, remarkMdxFiles],
  },
});
