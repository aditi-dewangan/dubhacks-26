// Agent owns declarations; Bridge owns validation and execution.
// JSON Schema declarations can be passed as Gemini parametersJsonSchema.
type Schema = Record<string, unknown>;
const id: Schema = { type: "string", minLength: 1 };
const qty: Schema = { type: "integer", minimum: 1, maximum: 10 };
const options: Schema = {
  type: "object",
  description: "Menu option group IDs mapped to arrays of choice IDs. Ask for missing required choices; never guess.",
  additionalProperties: { type: "array", items: id, uniqueItems: true },
};
const object = (properties: Record<string, Schema> = {}, required: string[] = []): Schema => ({
  type: "object", properties, required, additionalProperties: false,
});

export const agentTools = [
  { name: "get_menu", description: "Read available items, prices and option groups, optionally for one category.",
    parametersJsonSchema: object({ categoryId: id }) },
  { name: "get_kiosk_state", description: "Read the current screen, popup, cart and actual cart line IDs.",
    parametersJsonSchema: object() },
  { name: "add_item", description: "Add an item the customer requested, with all required options. Only report success after the bridge confirms it.",
    parametersJsonSchema: object({ itemId: id, qty, options }, ["itemId", "qty", "options"]) },
  { name: "update_item", description: "Change an existing cart line by its actual line ID. Supply quantity, options, or both. An empty choice array clears an optional group.",
    parametersJsonSchema: object({ lineId: id, qty, options }, ["lineId"]) },
  { name: "remove_item", description: "Remove the cart line the customer requested, using its actual line ID.",
    parametersJsonSchema: object({ lineId: id }, ["lineId"]) },
  { name: "respond_to_popup", description: "Press a button from the current popup after the customer chooses. Never accept an upsell without explicit consent.",
    parametersJsonSchema: object({ buttonId: id }, ["buttonId"]) },
  { name: "request_checkout", description: "Request an order review and open the explicit confirmation gate. This does not start payment. Read back the items and total.",
    parametersJsonSchema: object() },
  { name: "cancel_order", description: "Clear the order when the customer explicitly asks to start over or cancel.",
    parametersJsonSchema: object() },
  { name: "press_button", description: "On a clinic, cinema or transit kiosk, press an on-screen button by its ID or label after the customer chooses. Pay and Complete check-in can't be pressed; use request_checkout.",
    parametersJsonSchema: object({ buttonId: id }, ["buttonId"]) },
  { name: "type_text", description: "On a clinic, cinema or transit kiosk, type the customer's answer into an on-screen text field by its ID or label. Only type what the customer said; never invent personal details.",
    parametersJsonSchema: object({ fieldId: id, text: { type: "string", minLength: 1, maxLength: 80 } }, ["fieldId", "text"]) },
] as const;

export type AgentToolName = (typeof agentTools)[number]["name"];

export function isAgentToolName(name: string): name is AgentToolName {
  return agentTools.some((tool) => tool.name === name);
}

/** Only the eight agreed tools are exposed. Bridge still validates every input. */
export async function dispatchAgentTool(
  execute: (sessionId: string, name: string, input: unknown) => Promise<string>,
  sessionId: string,
  name: string,
  input: unknown,
): Promise<string> {
  if (!isAgentToolName(name)) return `Unknown agent tool: ${name}.`;
  return execute(sessionId, name, input);
}
