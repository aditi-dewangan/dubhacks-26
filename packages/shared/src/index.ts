export * from "./types.ts";
export * from "./codes.ts";
export * as fixtures from "./fixtures.ts";
import menuJson from "../menu.json" with { type: "json" };
import type { Menu } from "./types.ts";

export const menu = menuJson as unknown as Menu;
