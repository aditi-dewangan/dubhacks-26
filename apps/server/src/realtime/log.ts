import { appendFile, readFile } from "node:fs/promises";
import type { LoggedEvent, LoggedEventType } from "@kiosk-access/shared";
import { config } from "../config.ts";

// Every event is kept in memory for fast reads and appended to events.jsonl for the dashboard.
const recent: LoggedEvent[] = [];
let writeChain: Promise<void> = Promise.resolve();

export async function loadPreviousEvents() {
  try {
    const text = await readFile(config.eventsFile, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim()) recent.push(JSON.parse(line));
    }
  } catch {
    // no file yet
  }
}

export function logEvent(
  type: LoggedEventType,
  fields: { kioskId?: string; sessionId?: string; data?: Record<string, unknown> } = {},
) {
  const event: LoggedEvent = { at: new Date().toISOString(), type, ...fields };
  recent.push(event);
  if (recent.length > 20_000) recent.splice(0, recent.length - 20_000);
  writeChain = writeChain
    .then(() => appendFile(config.eventsFile, JSON.stringify(event) + "\n"))
    .catch((err) => console.error("[log] write failed", err));
}

export function getEvents(since?: string): LoggedEvent[] {
  if (!since) return recent;
  return recent.filter((e) => e.at > since);
}
