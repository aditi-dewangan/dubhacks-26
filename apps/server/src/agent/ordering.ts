import { menu, type KioskState } from "@kiosk-access/shared";

/** Agent-side guardrails to turn common malformed calls into useful questions. Bridge stays authoritative. */
export function validateAddItemInput(input: unknown): string | null {
  return validateItemInput(input, false);
}

function validateItemInput(input: unknown, allowHidden: boolean): string | null {
  if (!isRecord(input)) return "The add_item request was malformed. Ask which menu item the customer wants.";
  const itemId = input.itemId;
  const item = typeof itemId === "string" ? menu.items.find((candidate) => candidate.id === itemId) : undefined;
  if (!item || (item.hidden && !allowHidden)) {
    const itemName = typeof itemId === "string" ? itemId : "that item";
    return `No available item has ID "${itemName}". Check get_menu and ask the customer which listed item they want.`;
  }
  if (!Number.isInteger(input.qty) || (input.qty as number) < 1 || (input.qty as number) > 10) {
    return "Quantity must be a whole number from 1 through 10. Ask how many they want.";
  }
  if (!isRecord(input.options)) return `Options for ${item.name} must be an object of option group IDs and choice ID lists.`;

  for (const [groupId, choices] of Object.entries(input.options)) {
    const group = item.optionGroups.find((candidate) => candidate.id === groupId);
    if (!group) {
      const available = item.optionGroups.map((candidate) => candidate.name).join(", ") || "none";
      return `${item.name} does not have a ${groupId} option. Its option groups are: ${available}. Do not make that change.`;
    }
    if (!Array.isArray(choices) || choices.some((choice) => typeof choice !== "string")) {
      return `Options for ${group.name} must be a list of valid choices.`;
    }
    if (new Set(choices).size !== choices.length) return `Each ${group.name.toLowerCase()} choice may appear only once.`;
    if (group.type === "single" && choices.length > 1) {
      return `Only one ${group.name.toLowerCase()} can be selected for ${item.name}. Ask which one they want.`;
    }
    const unknown = choices.filter((choice) => !group.choices.some((candidate) => candidate.id === choice));
    if (unknown.length) {
      const choices = group.choices.map((candidate) => `${candidate.name} (ID ${candidate.id})`).join(", ");
      return `"${unknown[0]}" is not a ${group.name.toLowerCase()} choice for ${item.name}. Valid choices are ${choices}.`;
    }
  }

  const missing = item.optionGroups.filter((group) => {
    const choices = (input.options as Record<string, unknown>)[group.id];
    return group.required && (!Array.isArray(choices) || choices.length === 0);
  });
  if (missing.length) {
    const group = missing[0];
    const choices = group.choices.map((choice) => `${choice.name} (ID ${choice.id})`).join(" or ");
    return `${group.name} is required for ${item.name}: ${choices}. Do not choose a default. Ask the customer.`;
  }
  return null;
}

/** Make sure a response cannot silently accept or skip a kiosk popup. */
export function validateActionForState(name: string, input: unknown, state: KioskState | null): string | null {
  if (!state?.popup) return name === "respond_to_popup" ? "There is no current popup to answer. Read the latest kiosk state." : null;
  if (name !== "respond_to_popup") {
    const choices = state.popup.buttons.map((button) => `${button.label} (ID ${button.id})`).join(", ");
    return `Not executed. The kiosk popup says: "${state.popup.text}". Explain it and ask the customer which button to choose: ${choices}.`;
  }
  const buttonId = isRecord(input) ? input.buttonId : undefined;
  const button = typeof buttonId === "string" && state.popup.buttons.find((candidate) => candidate.id === buttonId);
  if (!button) {
    const choices = state.popup.buttons.map((candidate) => `${candidate.label} (ID ${candidate.id})`).join(", ");
    return `That popup choice is unavailable. Ask the customer to choose one of: ${choices}.`;
  }
  return null;
}

/** Validate patches against the current line so omitted option groups are preserved. */
export function validateCartEdit(name: string, input: unknown, state: KioskState | null): string | null {
  if (name !== "update_item" && name !== "remove_item") return null;
  if (!state) return "The current order is unavailable. Read kiosk state before changing a cart line.";
  if (state.screen === "paying" || state.screen === "complete") return "This order is already in payment or complete. Do not change it.";
  if (!isRecord(input) || typeof input.lineId !== "string") return "A current cart line ID is required. Read kiosk state.";
  const line = state.cart.lines.find((line) => line.lineId === input.lineId);
  if (!line) return "That cart line no longer exists. Read the current order and ask which item to change.";
  if (name === "remove_item") return null;
  if (input.qty === undefined && input.options === undefined) return "Specify a quantity or option change for this item.";
  if (input.options !== undefined && !isRecord(input.options)) return "Option changes must be an object of group IDs and choice lists.";
  if (input.qty === undefined && Object.keys(input.options as object).length === 0) return "Specify an option change for this item.";
  return validateItemInput({ itemId: line.itemId, qty: input.qty === undefined ? line.qty : input.qty,
    options: { ...line.options, ...(input.options as Record<string, unknown> ?? {}) } }, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
