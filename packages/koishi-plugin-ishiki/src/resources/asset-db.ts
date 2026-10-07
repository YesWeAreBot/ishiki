import type { Context } from "koishi";

import type { AssetDatabase, AssetRecord } from "./asset.js";

declare module "koishi" {
  interface Tables {
    ishiki_assets: AssetRecord;
  }
}

/** Minato-backed asset row store. One database table, rows keyed by (runtimeId, id). */
export class MinatoAssetDatabase implements AssetDatabase {
  public constructor(private readonly ctx: Context) {}

  async get(runtimeId: string, id: string): Promise<AssetRecord | undefined> {
    const rows = await this.ctx.database.get("ishiki_assets", { runtimeId, id });
    return rows[0];
  }

  async prefixSearch(runtimeId: string, prefix: string): Promise<AssetRecord[]> {
    const rows = await this.ctx.database.get("ishiki_assets", { runtimeId });
    return rows.filter((row) => row.id.startsWith(prefix));
  }

  async listIds(runtimeId: string): Promise<string[]> {
    const rows = await this.ctx.database.get("ishiki_assets", { runtimeId }, ["id"]);
    return rows.map((row) => row.id);
  }

  async create(row: AssetRecord): Promise<void> {
    await this.ctx.database.create("ishiki_assets", row);
  }

  async markFetched(runtimeId: string, id: string, data: { byteLength: number; contentHash: string }): Promise<void> {
    await this.ctx.database.set("ishiki_assets", { runtimeId, id }, { ...data, fetchedAt: Date.now() });
  }
}

/** Declare the asset table on the app's model; call once from the service constructor. */
export function defineAssetTable(ctx: Context): void {
  ctx.model.extend(
    "ishiki_assets",
    {
      id: "string(32)",
      runtimeId: "string(255)",
      src: "text",
      mediaType: "string(255)",
      byteLength: "unsigned(8)",
      contentHash: "string(64)",
      ingestedAt: "unsigned(8)",
      fetchedAt: "unsigned(8)",
      filename: "string(255)",
    },
    { primary: ["runtimeId", "id"], autoInc: false },
  );
}
