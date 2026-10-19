/** 协议后端：两套实现的动作名与参数形状并不完全一致。 */
export type Backend = "napcat" | "snowluma";

/** 工具可见档位：docs 只查文档；read 加只读执行；write 加全部执行。 */
export type Mode = "docs" | "read" | "write";

/** 媒体参数的传输方式：内联进 params，或发布成 HTTP URL 交给协议端拉取。 */
export type MediaTransport = "inline" | "http";

export interface ParamDoc {
  type?: string;
  description?: string;
  enum?: readonly unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  items?: unknown;
  anyOf?: readonly unknown[];
  oneOf?: readonly unknown[];
}

/** 只在某一个后端存在的参数，以及它自己的必填项。 */
export interface ActionVariant {
  params?: Record<string, ParamDoc>;
  required?: string[];
}

export interface CatalogAction {
  name: string;
  category: string;
  summary: string;
  description?: string;
  /** 动作在哪些后端存在。 */
  backends: Backend[];
  /** 各后端的实际动作名：别名折叠后，规范名可能与线上名字不同。 */
  wire: Partial<Record<Backend, string>>;
  /** 各后端的只读判定；执行前按当前 backend 取。 */
  readOnly: Record<Backend, boolean>;
  aliases: string[];
  /** 两边都有的参数。 */
  params: Record<string, ParamDoc>;
  /** 两边都必填的参数；单后端动作即它自己的必填项。 */
  required: string[];
  variants?: Partial<Record<Backend, ActionVariant>>;
  /** 该动作在 NapCat 首次出现的文档版本。 */
  since?: string;
  deprecated?: boolean;
  /** 无论模式如何都拒绝执行。 */
  deny?: boolean;
  note?: string;
  /** 参数名到传输方式的映射；未列出的媒体参数按 inline 处理。 */
  media?: Record<string, MediaTransport>;
}
