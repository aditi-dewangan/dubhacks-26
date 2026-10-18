import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { menu } from "@kiosk-access/shared";

// menu.json is the one file every app builds against, so check it hard.

const raw = JSON.parse(
  readFileSync(new URL("../../../../packages/shared/menu.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const isMoney = (n: unknown) => typeof n === "number" && Number.isFinite(n) && Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

describe("menu.json", () => {
  it("has only the Menu fields", () => {
    expect(Object.keys(raw).sort()).toEqual(["categories", "items", "taxRate"]);
    expect(menu.taxRate).toBeGreaterThan(0);
    expect(menu.taxRate).toBeLessThan(0.2);
  });

  it("has 4 categories and about 12 orderable items", () => {
    expect(menu.categories.map((c) => c.id)).toEqual(["combos", "chicken", "sides", "drinks"]);
    const visible = menu.items.filter((i) => !i.hidden);
    expect(visible.length).toBeGreaterThanOrEqual(10);
    expect(visible.length).toBeLessThanOrEqual(14);
    for (const c of menu.categories) expect(visible.some((i) => i.categoryId === c.id)).toBe(true);
  });

  it("every item matches the MenuItem type", () => {
    const categoryIds = new Set(menu.categories.map((c) => c.id));
    const ids = new Set<string>();
    for (const item of menu.items) {
      expect(ids.has(item.id), `duplicate id ${item.id}`).toBe(false);
      ids.add(item.id);
      expect(item.id).toMatch(/^[a-z0-9_]+$/);
      expect(categoryIds.has(item.categoryId), `${item.id} category`).toBe(true);
      expect(typeof item.name).toBe("string");
      expect(typeof item.description).toBe("string");
      expect(Array.isArray(item.tags)).toBe(true);
      expect(isMoney(item.price) && item.price > 0, `${item.id} price`).toBe(true);
      expect(Array.isArray(item.optionGroups)).toBe(true);

      const groupIds = new Set<string>();
      for (const g of item.optionGroups) {
        expect(groupIds.has(g.id), `${item.id} duplicate group ${g.id}`).toBe(false);
        groupIds.add(g.id);
        expect(["single", "multi"]).toContain(g.type);
        expect(typeof g.required).toBe("boolean");
        expect(g.choices.length).toBeGreaterThan(0);
        const choiceIds = new Set(g.choices.map((c) => c.id));
        expect(choiceIds.size, `${item.id}.${g.id} duplicate choice`).toBe(g.choices.length);
        for (const c of g.choices) {
          expect(typeof c.name).toBe("string");
          expect(isMoney(c.priceDelta), `${item.id}.${g.id}.${c.id} priceDelta`).toBe(true);
        }
      }
    }
  });

  it("has a required single-choice group", () => {
    const combo = menu.items.find((i) => i.id === "box_combo")!;
    const drink = combo.optionGroups.find((g) => g.id === "drink")!;
    expect(drink).toMatchObject({ type: "single", required: true });
  });

  it("has optional removals", () => {
    const combo = menu.items.find((i) => i.id === "box_combo")!;
    const remove = combo.optionGroups.find((g) => g.id === "remove")!;
    expect(remove).toMatchObject({ type: "multi", required: false });
    expect(remove.choices.map((c) => c.id)).toContain("no_coleslaw");
  });

  it("every upsell points at a hidden item, and every hidden item has an upsell", () => {
    const byId = new Map(menu.items.map((i) => [i.id, i]));
    const upsellTargets = new Set<string>();
    for (const item of menu.items) {
      if (!item.upsell) continue;
      const target = byId.get(item.upsell.itemId);
      expect(target, `${item.id} upsell target`).toBeDefined();
      expect(target!.hidden).toBe(true);
      expect(target!.price).toBe(item.upsell.priceDelta);
      upsellTargets.add(target!.id);
    }
    expect(upsellTargets.size).toBeGreaterThan(0);
    for (const item of menu.items.filter((i) => i.hidden)) expect(upsellTargets.has(item.id)).toBe(true);
  });
});
