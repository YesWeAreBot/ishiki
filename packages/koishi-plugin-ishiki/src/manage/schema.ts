import type Schema from "schemastery";

export interface SchemaNode {
  type: string;
  meta: Record<string, unknown>;
  dict?: Record<string, SchemaNode>;
  list?: SchemaNode[];
  inner?: SchemaNode;
  value?: unknown;
}

interface SchemaJson {
  uid: number;
  refs: Record<string, SchemaJsonEntry>;
}

interface SchemaJsonEntry {
  type: string;
  meta: Record<string, unknown>;
  dict?: Record<string, number>;
  list?: number[];
  inner?: number;
  sKey?: number;
  value?: unknown;
}

/** Turn schemastery's reference table into a plain tree the browser can walk. */
export function serializeSchema(schema: Schema | undefined): SchemaNode | undefined {
  if (schema === undefined) return undefined;
  const json = schema.toJSON() as unknown as SchemaJson;
  const refs = new Map(Object.entries(json.refs ?? {}));

  const resolve = (id: number): SchemaNode => {
    const entry = refs.get(String(id));
    if (entry === undefined) throw new Error(`schema reference ${id} is missing`);
    const node: SchemaNode = { type: entry.type, meta: { ...entry.meta } };
    if (entry.dict !== undefined) {
      node.dict = Object.fromEntries(Object.entries(entry.dict).map(([key, child]) => [key, resolve(child)]));
    }
    if (entry.list !== undefined) node.list = entry.list.map(resolve);
    if (entry.inner !== undefined) node.inner = resolve(entry.inner);
    if (entry.value !== undefined) node.value = entry.value;
    return node;
  };

  return resolve(json.uid);
}
