// Checks every agent request against menu.json before anything reaches the kiosk.
// Errors are written to be said aloud by the agent ("Size is required: regular or large.").

import { menu, type CartLine, type KioskState, type MenuItem, type MenuOptionGroup } from "@kiosk-access/shared";

export type Options = Record<string, string[]>;
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: string): Result<T> => ({ ok: false, error });

const visible = menu.items.filter((i) => !i.hidden);

/** "the box combo" → "box combo", so sentences don't say "the the box combo". */
const noun = (name: string) => name.toLowerCase().replace(/^the /, "");

/** "a chicken sandwich or chicken finger": whatever offers this hidden item in its popup. */
function offeredAfter(hiddenId: string): string {
  const offers = visible.filter((i) => i.upsell?.itemId === hiddenId).map((i) => noun(i.name));
  return offers.length ? `a ${orList(offers)}` : "another item";
}
const itemsById = new Map(menu.items.map((i) => [i.id, i]));

// ---------------- text matching ----------------

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[_-]/g, " ")
    .replace(/[^a-z0-9' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Forms of a phrase to match on: as is, and without a plural "s" on the last word. */
function forms(s: string): string[] {
  const n = normalize(s);
  const out = [n];
  if (n.endsWith("es")) out.push(n.slice(0, -2));
  if (n.endsWith("s")) out.push(n.slice(0, -1));
  return out;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const tokens = (s: string) => new Set(normalize(s).split(" ").filter((t) => t.length > 2));

/** Best candidate for a misheard or misspelled name: shared words first, then edit distance. */
function closest<T>(query: string, candidates: T[], names: (c: T) => string[]): { match: T; distance: number; shared: number } | null {
  const q = normalize(query);
  const qTokens = tokens(query);
  let best: { match: T; distance: number; shared: number } | null = null;
  for (const c of candidates) {
    for (const name of names(c)) {
      const n = normalize(name);
      const shared = [...tokens(name)].filter((t) => qTokens.has(t)).length;
      const distance = levenshtein(q, n);
      if (!best || shared > best.shared || (shared === best.shared && distance < best.distance)) {
        best = { match: c, distance, shared };
      }
    }
  }
  if (!best) return null;
  const closeEnough = best.shared > 0 || best.distance <= Math.max(2, Math.floor(q.length * 0.4));
  return closeEnough ? best : null;
}

function joinList(words: string[], last: "or" | "and"): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`;
}
const orList = (words: string[]) => joinList(words, "or");
const andList = (words: string[]) => joinList(words, "and");

// ---------------- aliases ----------------

type Alias = { itemId: string; options?: Options } | { categoryId: string };

const ALIASES: Record<string, Alias> = {
  // Combos
  box: { itemId: "box_combo" },
  "the box": { itemId: "box_combo" },
  "box combo": { itemId: "box_combo" },
  caniac: { itemId: "caniac_combo" },
  "caniac combo": { itemId: "caniac_combo" },
  "3 finger": { itemId: "three_finger_combo" },
  "three finger": { itemId: "three_finger_combo" },
  "3 finger combo": { itemId: "three_finger_combo" },
  "three finger combo": { itemId: "three_finger_combo" },
  "sandwich combo": { itemId: "sandwich_combo" },
  // Chicken
  sandwich: { itemId: "chicken_sandwich" },
  finger: { itemId: "chicken_finger" },
  "chicken finger": { itemId: "chicken_finger" },
  tender: { itemId: "chicken_finger" },
  "chicken tender": { itemId: "chicken_finger" },
  strip: { itemId: "chicken_finger" },
  "chicken strip": { itemId: "chicken_finger" },
  "party pack": { itemId: "tailgate" },
  // Sides
  "french fry": { itemId: "fries" },
  "french fries": { itemId: "fries" },
  "crinkle fries": { itemId: "fries" },
  chips: { itemId: "fries" },
  slaw: { itemId: "coleslaw" },
  "cole slaw": { itemId: "coleslaw" },
  toast: { itemId: "texas_toast" },
  sauce: { itemId: "canes_sauce" },
  "canes sauce": { itemId: "canes_sauce" },
  // Drinks
  "sweet tea": { itemId: "sweet_tea", options: { sweet: ["sweetened"] } },
  "unsweet tea": { itemId: "sweet_tea", options: { sweet: ["unsweetened"] } },
  "unsweetened tea": { itemId: "sweet_tea", options: { sweet: ["unsweetened"] } },
  tea: { itemId: "sweet_tea" },
  coke: { itemId: "fountain_drink", options: { flavor: ["cola"] } },
  cola: { itemId: "fountain_drink", options: { flavor: ["cola"] } },
  pepsi: { itemId: "fountain_drink", options: { flavor: ["cola"] } },
  "diet coke": { itemId: "fountain_drink", options: { flavor: ["diet_cola"] } },
  "diet cola": { itemId: "fountain_drink", options: { flavor: ["diet_cola"] } },
  sprite: { itemId: "fountain_drink", options: { flavor: ["lemon_lime"] } },
  "7up": { itemId: "fountain_drink", options: { flavor: ["lemon_lime"] } },
  "lemon lime": { itemId: "fountain_drink", options: { flavor: ["lemon_lime"] } },
  "root beer": { itemId: "fountain_drink", options: { flavor: ["root_beer"] } },
  soda: { itemId: "fountain_drink" },
  pop: { itemId: "fountain_drink" },
  "soft drink": { itemId: "fountain_drink" },
  // The combo upgrade is only offered in a popup
  upgrade: { itemId: "combo_upgrade" },
  "combo upgrade": { itemId: "combo_upgrade" },
  // Categories
  combo: { categoryId: "combos" },
  meal: { categoryId: "combos" },
  side: { categoryId: "sides" },
  drink: { categoryId: "drinks" },
  beverage: { categoryId: "drinks" },
};

function lookupAlias(query: string): Alias | undefined {
  for (const f of forms(query)) if (ALIASES[f]) return ALIASES[f];
  return undefined;
}

// ---------------- items and categories ----------------

export type ItemMatch =
  | { kind: "item"; item: MenuItem; presetOptions: Options }
  | { kind: "category"; categoryId: string; items: MenuItem[] }
  | { kind: "none"; suggestion?: MenuItem };

/** Resolves an item id, a name, or an alias. Hidden items are returned as items (callers reject them). */
export function matchItem(query: string): ItemMatch {
  const exact = itemsById.get(query);
  if (exact) return { kind: "item", item: exact, presetOptions: {} };

  const alias = lookupAlias(query);
  if (alias && "categoryId" in alias) {
    return { kind: "category", categoryId: alias.categoryId, items: visible.filter((i) => i.categoryId === alias.categoryId) };
  }
  if (alias) return { kind: "item", item: itemsById.get(alias.itemId)!, presetOptions: alias.options ?? {} };

  const qForms = forms(query);
  for (const item of menu.items) {
    const names = [...forms(item.id), ...forms(item.name)];
    if (qForms.some((q) => names.includes(q))) return { kind: "item", item, presetOptions: {} };
  }
  const cat = menu.categories.find((c) => qForms.some((q) => forms(c.id).includes(q) || forms(c.name).includes(q)));
  if (cat) return { kind: "category", categoryId: cat.id, items: visible.filter((i) => i.categoryId === cat.id) };

  // A small typo ("chesseburger") is the same item; anything further is only a suggestion.
  const typo = closest(query, visible, (i) => [i.name, i.id]);
  if (typo && typo.distance <= 2 && normalize(query).length >= 6) {
    return { kind: "item", item: typo.match, presetOptions: {} };
  }
  return { kind: "none", suggestion: suggestItem(query) };
}

/**
 * "chicken burger" -> crispy chicken sandwich: words that name the food ("chicken") count
 * most, then words that name a category ("burger" -> burgers), then edit distance.
 */
function suggestItem(query: string): MenuItem | undefined {
  const words = [...tokens(query)];
  const categoryWords = new Map<string, string>();
  for (const w of words) {
    const alias = lookupAlias(w);
    if (alias && "categoryId" in alias) categoryWords.set(w, alias.categoryId);
  }
  const foodWords = words.filter((w) => !categoryWords.has(w));
  const q = normalize(query);
  const score = (i: MenuItem) => {
    const itemWords = new Set([...tokens(i.name), ...tokens(i.id)]);
    return [
      foodWords.filter((w) => [...itemWords].some((t) => forms(t).some((f) => forms(w).includes(f)))).length,
      [...categoryWords.values()].includes(i.categoryId) ? 1 : 0,
      -Math.min(levenshtein(q, normalize(i.name)), levenshtein(q, normalize(i.id))),
    ];
  };
  let best: { item: MenuItem; s: number[] } | undefined;
  for (const item of visible) {
    const s = score(item);
    if (!best || s[0] > best.s[0] || (s[0] === best.s[0] && (s[1] > best.s[1] || (s[1] === best.s[1] && s[2] > best.s[2])))) {
      best = { item, s };
    }
  }
  if (!best) return undefined;
  const [food, cat, negDist] = best.s;
  return food > 0 || cat > 0 || -negDist <= Math.max(2, Math.floor(q.length * 0.4)) ? best.item : undefined;
}

/** An item the customer can order directly, with any options the alias implies. */
export function resolveOrderableItem(query: unknown): Result<{ item: MenuItem; presetOptions: Options }> {
  if (typeof query !== "string" || !query.trim()) return fail("Which item? I need an item name or id.");
  const m = matchItem(query.trim());
  if (m.kind === "category") {
    const names = m.items.map((i) => i.name.toLowerCase());
    return fail(`"${query}" could be any of these: ${orList(names)}. Which one?`);
  }
  if (m.kind === "none") {
    return fail(m.suggestion
      ? `No item "${query}". Closest: ${m.suggestion.name.toLowerCase()}.`
      : `No item "${query}" on this menu.`);
  }
  if (m.item.hidden) {
    return fail(`The ${noun(m.item.name)} can't be ordered directly. It's offered in a popup after adding ${offeredAfter(m.item.id)}.`);
  }
  return ok({ item: m.item, presetOptions: m.presetOptions });
}

export function resolveCategory(query: unknown): Result<string | null> {
  if (query === undefined || query === null || query === "") return ok(null);
  if (typeof query !== "string") return fail("categoryId must be text.");
  const byId = menu.categories.find((c) => c.id === query);
  if (byId) return ok(byId.id);
  const m = matchItem(query);
  if (m.kind === "category") return ok(m.categoryId);
  return fail(`No category "${query}". Categories: ${andList(menu.categories.map((c) => c.name.toLowerCase()))}.`);
}

// ---------------- options ----------------

function findGroup(item: MenuItem, key: string): MenuOptionGroup | undefined {
  const k = normalize(key);
  return item.optionGroups.find((g) => g.id === key || normalize(g.id) === k || normalize(g.name) === k);
}

function findChoice(group: MenuOptionGroup, value: string) {
  const exact = group.choices.find((c) => c.id === value);
  if (exact) return exact;
  // "onions" or "no onion" in a removal group both mean no_onions.
  const strip = (s: string) => s.replace(/^no /, "");
  const v = forms(value).flatMap((f) => [f, strip(f)]);
  return group.choices.find((c) =>
    [...forms(c.id), ...forms(c.name)].flatMap((f) => [f, strip(f)]).some((n) => v.includes(n)),
  );
}

const choiceNames = (g: MenuOptionGroup) => g.choices.map((c) => c.name.toLowerCase());

/**
 * Turns whatever the model sent into { groupId: [choiceId] } for this item. Group and
 * choice names are accepted as well as ids, and a single string counts as a one-item list.
 * With requireAll, every required group must have a choice.
 */
export function validateOptions(item: MenuItem, raw: unknown, requireAll: boolean): Result<Options> {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return fail(`Options must map option names to choices, like { "size": ["large"] }.`);
  }
  const itemName = noun(item.name);
  const out: Options = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const group = findGroup(item, key);
    if (!group) {
      const groups = item.optionGroups.map((g) => g.name.toLowerCase());
      return fail(groups.length
        ? `The ${itemName} has no "${key}" option. Its options are: ${andList(groups)}.`
        : `The ${itemName} has no options.`);
    }
    const values = typeof value === "string" ? [value] : value;
    if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) {
      return fail(`Choices for ${group.name.toLowerCase()} must be a list, like ["${group.choices[0].id}"].`);
    }
    const ids: string[] = [];
    for (const v of values as string[]) {
      const choice = findChoice(group, v);
      if (!choice) {
        const near = closest(v, group.choices, (c) => [c.name, c.id]);
        const hint = near ? ` Did you mean ${near.match.name.toLowerCase()}?` : "";
        return fail(`"${v}" isn't a ${group.name.toLowerCase()} choice for the ${itemName}.${hint} Choices: ${orList(choiceNames(group))}.`);
      }
      if (!ids.includes(choice.id)) ids.push(choice.id);
    }
    if (group.type === "single" && ids.length > 1) {
      return fail(`Pick one ${group.name.toLowerCase()}: ${orList(choiceNames(group))}.`);
    }
    out[group.id] = ids;
  }
  if (requireAll) {
    const missing = item.optionGroups.filter((g) => g.required && !out[g.id]?.length);
    if (missing.length) {
      return fail(missing.map((g) => `${g.name} is required: ${orList(choiceNames(g))}.`).join(" "));
    }
  }
  return ok(out);
}

export function validateQty(raw: unknown, fallback?: number): Result<number> {
  const qty = raw === undefined || raw === null ? fallback : typeof raw === "string" ? Number(raw) : raw;
  if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 10) {
    return fail("Quantity must be a whole number from 1 to 10.");
  }
  return ok(qty);
}

// ---------------- cart lines ----------------

const lineList = (lines: CartLine[]) =>
  lines.map((l) => `${l.lineId} (${l.qty} ${l.name.toLowerCase()})`).join(", ");

/** A cart line by its id, or by item when only one line has that item. */
export function resolveLine(state: KioskState, ref: unknown): Result<CartLine> {
  const lines = state.cart.lines;
  if (!lines.length) return fail("The order is empty.");
  if (typeof ref !== "string" || !ref.trim()) return fail(`Which line? Lines: ${lineList(lines)}.`);
  const byId = lines.find((l) => l.lineId.toLowerCase() === ref.trim().toLowerCase());
  if (byId) return ok(byId);

  const m = matchItem(ref.trim());
  if (m.kind === "item") {
    const same = lines.filter((l) => l.itemId === m.item.id);
    if (same.length === 1) return ok(same[0]);
    if (same.length > 1) return fail(`There are ${same.length} ${m.item.name.toLowerCase()} lines: ${lineList(same)}. Which one?`);
  }
  return fail(`No line "${ref}" in the order. Lines: ${lineList(lines)}.`);
}

/** A button on the current popup, by id, label, or a plain "yes"/"no". */
export function resolvePopupButton(state: KioskState, ref: unknown): Result<string> {
  const popup = state.popup;
  if (!popup) return fail("There's no popup showing right now.");
  const ids = popup.buttons.map((b) => b.id);
  const list = popup.buttons.map((b) => `${b.id} ("${b.label}")`).join(", ");
  if (typeof ref !== "string" || !ref.trim()) return fail(`Which button? ${list}.`);
  if (ids.includes(ref)) return ok(ref);

  const r = normalize(ref);
  if (/^(yes|yeah|yep|sure|ok|okay)\b/.test(r) && ids.includes("popup-yes")) return ok("popup-yes");
  if (/^(no|nope|never ?mind)\b/.test(r) && ids.includes("popup-no")) return ok("popup-no");
  const byLabel = popup.buttons.find((b) => {
    const label = normalize(b.label);
    return label === r || normalize(b.id.replace(/^popup-(drink-)?/, "")) === r || (r.length > 3 && label.includes(r));
  });
  if (byLabel) return ok(byLabel.id);
  // A drink said by its everyday name ("coke") on the combo drink popup.
  const alias = lookupAlias(ref);
  const flavor = alias && "itemId" in alias ? alias.options?.flavor?.[0] : undefined;
  if (flavor && ids.includes(`popup-drink-${flavor}`)) return ok(`popup-drink-${flavor}`);
  return fail(`No "${ref}" button on the popup. Buttons: ${list}.`);
}
