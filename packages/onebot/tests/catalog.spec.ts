import { describe, expect, it } from "vitest";

import { actionsFor, categoriesFor, findAction, search, shapeOf } from "../src/catalog/index.js";
import { renderAction, renderIndex } from "../src/catalog/render.js";

describe("catalog data", () => {
  it("covers both backends without duplicate names", () => {
    const names = actionsFor("napcat").map((action) => action.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(150);

    const snowluma = actionsFor("snowluma").map((action) => action.name);
    expect(snowluma.length).toBeGreaterThan(names.length);
  });

  it("resolves aliases to the canonical action", () => {
    expect(findAction(".ocr_image")?.name).toBe("ocr_image");
    expect(findAction("ArkSharePeer")?.name).toBe("share_peer");
    expect(findAction("send_group_sign")?.name).toBe("set_group_sign");
    expect(findAction("upload_foward_msg")?.name).toBe("upload_forward_msg");
    expect(findAction("no_such_action")).toBeUndefined();
  });

  it("keeps backend-only actions out of the other catalog", () => {
    const onlyNapcat = findAction("get_guild_list");
    expect(onlyNapcat?.backends).toEqual(["napcat"]);
    expect(actionsFor("snowluma").some((action) => action.name === "get_guild_list")).toBe(false);

    const onlySnowluma = findAction("fetch_sys_faces");
    expect(onlySnowluma?.backends).toEqual(["snowluma"]);
    expect(actionsFor("napcat").some((action) => action.name === "fetch_sys_faces")).toBe(false);
  });

  it("merges backend variants instead of dropping them", () => {
    const history = findAction("get_group_msg_history");
    if (history === undefined) throw new Error("catalog is missing get_group_msg_history");
    expect(shapeOf(history, "napcat").required).toEqual(["group_id"]);
    expect(shapeOf(history, "napcat").params).toHaveProperty("message_seq");
    expect(shapeOf(history, "snowluma").params).toHaveProperty("message_id");
    expect(shapeOf(history, "snowluma").params).toHaveProperty("reverse_order");

    const upload = findAction("upload_group_file");
    if (upload === undefined) throw new Error("catalog is missing upload_group_file");
    expect(shapeOf(upload, "snowluma").params).toHaveProperty("upload_file");
  });

  it("marks read-only actions per backend", () => {
    const info = findAction("get_group_info");
    expect(info?.readOnly).toEqual({ napcat: true, snowluma: true });
    const record = findAction("get_ai_record");
    expect(record?.readOnly.napcat).toBe(false);
    const ocr = findAction("ocr_image");
    expect(ocr?.readOnly).toEqual({ napcat: true, snowluma: true });
    expect(ocr?.media).toEqual({ image: "http" });
    const mark = findAction("_mark_all_as_read");
    expect(mark?.readOnly.napcat).toBe(false);
  });

  it("disables the dangerous actions by default", () => {
    for (const name of ["bot_exit", "set_restart", "send_packet", "get_cookies", "get_credentials", "get_csrf_token"]) {
      const action = findAction(name);
      expect(action?.deny).toBe(true);
      expect(action?.note).toBeTypeOf("string");
    }
  });

  it("records when NapCat gained a newer action", () => {
    expect(findAction("get_group_share_link")?.since).toBe("4.18.26");
    expect(findAction("fetch_ptt_text")?.since).toBe("4.18.2");
    expect(findAction("get_group_info")?.since).toBeUndefined();
    expect(findAction("send_group_sign")?.name).toBe("set_group_sign");
  });

  it("counts actions per category for the chosen backend", () => {
    const categories = categoriesFor("napcat");
    expect(categories.length).toBeGreaterThan(5);
    expect(categories.reduce((sum, entry) => sum + entry.count, 0)).toBe(actionsFor("napcat").length);
    expect(categories.every((entry) => entry.count > 0)).toBe(true);
  });

  it("searches names, summaries, aliases, and categories", () => {
    expect(search("message_seq", "napcat").map((action) => action.name)).toContain("get_group_msg_history");
    expect(search("ArkSharePeer", "snowluma").map((action) => action.name)).toContain("share_peer");
    expect(search("群文件", "napcat").length).toBeGreaterThan(3);
    expect(search("", "napcat")).toEqual([]);
  });
});

describe("catalog rendering", () => {
  it("renders one action with its backend-specific parameters", () => {
    const action = findAction("get_group_msg_history");
    if (action === undefined) throw new Error("missing action");
    const text = renderAction(action, "snowluma");
    expect(text).toContain("# get_group_msg_history");
    expect(text).toContain("`message_id`");
    expect(text).toContain("`group_id`");
    expect(text).toContain("SnowLuma");
    expect(text).toContain("NapCat 独有参数");
    expect(text).toContain("`message_seq`");
  });

  it("renders the index grouped by category", () => {
    const text = renderIndex("napcat");
    expect(text).toContain("# OneBot 动作目录 (NapCat)");
    expect(text).toContain("## 消息");
    expect(text).toContain("`send_msg`");
    expect(text).not.toContain("`fetch_sys_faces`");
  });
});
