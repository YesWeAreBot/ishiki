import { ACTIONS, CATEGORIES } from "./generated.js";
import type { Backend, CatalogAction, ParamDoc } from "./types.js";

/** 名称与别名都指向同一条记录：模型可能从文档里抄到任一写法。 */
const byName: Record<string, CatalogAction> = Object.create(null);
for (const action of ACTIONS) {
  byName[action.name] = action;
  for (const alias of action.aliases) byName[alias] = action;
}

export function findAction(name: string): CatalogAction | undefined {
  return byName[name];
}

export function actionsFor(backend: Backend): CatalogAction[] {
  return ACTIONS.filter((action) => action.backends.includes(backend)).sort((left, right) => {
    const delta = CATEGORIES.indexOf(left.category as (typeof CATEGORIES)[number]) - CATEGORIES.indexOf(right.category as (typeof CATEGORIES)[number]);
    return delta !== 0 ? delta : left.name.localeCompare(right.name);
  });
}

export function categoriesFor(backend: Backend): Array<{ category: string; count: number }> {
  return CATEGORIES.map((category) => {
    const count = ACTIONS.filter((action) => action.backends.includes(backend) && action.category === category).length;
    return { category, count };
  }).filter((entry) => entry.count > 0);
}

/** 当前后端下参数与必填项：公共部分叠加该后端的变体。 */
export function shapeOf(action: CatalogAction, backend: Backend): { params: Record<string, ParamDoc>; required: string[] } {
  const variant = action.variants?.[backend];
  if (variant === undefined) return { params: action.params, required: action.required };
  return {
    params: { ...action.params, ...variant.params },
    required: variant.required === undefined ? action.required : [...new Set([...action.required, ...variant.required])].sort(),
  };
}

export interface LiteAction {
  name: string;
  aliases: string[];
  category: string;
  summary: string;
  readOnly: boolean;
  deprecated?: boolean;
  deny?: boolean;
}

/** 在当前后端的动作里按名称、摘要、别名、分类与参数名匹配。 */
export function search(query: string, backend: Backend): CatalogAction[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  return actionsFor(backend).filter((action) =>
    [action.name, ...action.aliases, action.summary, action.description ?? "", action.category, ...Object.keys(shapeOf(action, backend).params)]
      .join("\n")
      .toLowerCase()
      .includes(needle),
  );
}
