import * as AccordionComponents from "fumadocs-ui/components/accordion";
import * as StepsComponents from "fumadocs-ui/components/steps";
import * as TabsComponents from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { File, Folder, Files } from "@/components/files";
import { GraphView } from "@/components/graph-view";
import { Mermaid } from "@/components/mdx/mermaid";
import { buildGraph } from "@/lib/build-graph";

/** 文档页之间的引用关系图，图数据在渲染时从 source 现算 */
function DocsGraph() {
  return <GraphView graph={buildGraph()} />;
}

/** 文档 `.mdx` 里可以直接使用的组件集合 */
export type MDXProvidedComponents = MDXComponents & {
  TypeTable: typeof TypeTable;
  Files: typeof Files;
  File: typeof File;
  Folder: typeof Folder;
  Mermaid: typeof Mermaid;
  DocsGraph: typeof DocsGraph;
  Tabs: typeof TabsComponents.Tabs;
  Tab: typeof TabsComponents.Tab;
  TabsList: typeof TabsComponents.TabsList;
  TabsTrigger: typeof TabsComponents.TabsTrigger;
  TabsContent: typeof TabsComponents.TabsContent;
  Steps: typeof StepsComponents.Steps;
  Step: typeof StepsComponents.Step;
  Accordion: typeof AccordionComponents.Accordion;
  Accordions: typeof AccordionComponents.Accordions;
};

export function getMDXComponents(components?: MDXComponents): MDXProvidedComponents {
  return {
    ...defaultMdxComponents,
    ...TabsComponents,
    ...StepsComponents,
    ...AccordionComponents,
    TypeTable,
    Files,
    File,
    Folder,
    Mermaid,
    DocsGraph,
    ...components,
  };
}

export const useMDXComponents = getMDXComponents;

declare global {
  // MDX 工具链按约定读取这个全局名
  type MDXProvidedComponents = import("@/components/mdx").MDXProvidedComponents;
}
