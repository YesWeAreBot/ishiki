import type { Context } from "@koishijs/client";
import { icons } from "@koishijs/client";

import IshikiIcon from "./src/components/IshikiIcon.vue";
import IshikiApp from "./src/IshikiApp.vue";

import "./src/styles.css";

/** 控制台入口：只有一个 Ishiki 页面，页面内部自带侧栏。 */
export default function (ctx: Context): void {
  icons.register("ishiki", IshikiIcon);
  ctx.page({
    id: "ishiki",
    path: "/ishiki/:page*",
    name: "Ishiki",
    icon: "ishiki",
    order: 600,
    component: IshikiApp,
  });
}
