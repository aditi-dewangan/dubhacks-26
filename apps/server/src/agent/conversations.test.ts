import { test } from "node:test";
import { conversationCases, runConversation } from "./testing/conversations.ts";

for (const scenario of conversationCases) {
  test(`offline conversation contract: ${scenario.id}`, async () => { await runConversation(scenario); });
}
