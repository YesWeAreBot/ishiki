import type { Context } from "koishi";
interface TestRow {
  id: string;
}
declare module "koishi" {
  interface Tables {
    test_table: TestRow;
  }
}
export function probe(ctx: Context) {
  ctx.model.define("test_table", { id: "string" });
  ctx.database.get("test_table", {});
}
