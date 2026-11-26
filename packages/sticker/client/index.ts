import type { Context } from "@koishijs/client";
import { icons } from "@koishijs/client";

import StickerApp from "./src/StickerApp.vue";
import StickerIcon from "./src/StickerIcon.vue";

import "./src/styles.css";

export default function (ctx: Context): void {
  icons.register("ishiki-sticker", StickerIcon);
  ctx.page({
    id: "ishiki-sticker",
    path: "/ishiki-stickers",
    name: "表情图库",
    icon: "ishiki-sticker",
    order: 590,
    component: StickerApp,
  });
}
