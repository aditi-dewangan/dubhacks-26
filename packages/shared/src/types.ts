// The shared contract from the build plan. Change it only after telling the whole team.

// ---------- Kiosk state (kiosk -> server -> phone) ----------

/** Screens of the food kiosk. Other kiosk kinds use their own screen names (any string). */
export type FoodScreen = "welcome" | "menu" | "item" | "cart" | "checkout" | "paying" | "complete";
// `string & {}` keeps autocomplete for the food screens while allowing other kiosks' names.
export type Screen = FoodScreen | (string & {});

/** Which kind of kiosk is publishing. Food kiosks support add_item etc.; every kind supports press and type_text. */
export type KioskKind = "food" | "clinic" | "cinema" | "transit";

/** A text field on screen (clinic check-in name, date of birth, ...). Fill it with type_text. */
export interface KioskField {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
}

export interface KioskButton {
  id: string;
  label: string;
  enabled: boolean;
}

export interface KioskPopup {
  id: string;
  text: string;
  buttons: { id: string; label: string }[];
}

export interface CartLine {
  lineId: string;
  itemId: string;
  name: string;
  qty: number;
  options: Record<string, string[]>;
  lineTotal: number;
}

export interface Cart {
  lines: CartLine[];
  subtotal: number;
  tax: number;
  total: number;
}

export interface KioskState {
  kioskId: string;
  screen: Screen;
  title: string;
  buttons: KioskButton[];
  popup?: KioskPopup;
  cart: Cart;
  orderNumber?: string;
  sessionActive: boolean;
  /** Kind of kiosk. Missing means "food" (older kiosks). */
  kind?: KioskKind;
  /** Text fields on screen. */
  fields?: KioskField[];
  /** Other information shown on screen, one line each (appointment details, prices, instructions). */
  info?: string[];
}

// ---------- Commands (server -> kiosk) and acks (kiosk -> server) ----------

export type KioskCommand =
  | { type: "add_item"; itemId: string; qty: number; options: Record<string, string[]> }
  | { type: "update_item"; lineId: string; qty?: number; options?: Record<string, string[]> }
  | { type: "remove_item"; lineId: string }
  | { type: "press"; buttonId: string }
  | { type: "type_text"; fieldId: string; text: string } // fills a text field (any kiosk kind)
  | { type: "start_payment" } // only the Bridge's confirm handler sends this
  | { type: "cancel_order" };

export interface CommandEnvelope {
  cmdId: string;
  sessionId: string;
  command: KioskCommand;
}

export interface CommandAck {
  cmdId: string;
  ok: boolean;
  error?: string;
  state: KioskState;
}

// ---------- Socket events ----------

export interface PairingCode {
  url: string;
  expiresAt: number;
}

export interface SessionInfo {
  sessionId: string;
  active: boolean;
  reason?: SessionEndReason;
}

export type SessionEndReason =
  | "idle_timeout"
  | "order_complete"
  | "staff_ended"
  | "phone_disconnected"
  | "user_ended"
  | "kiosk_disconnected";

export interface AgentMessage {
  text: string;
  awaitingConfirmation: boolean;
}

export interface KioskRegistration {
  kioskId: string;
  kioskKey: string;
}

export type RegisterResult = { ok: true } | { ok: false; error: string };

/** Events the server sends. */
export interface ServerToClientEvents {
  "kiosk:pairing-code": (code: PairingCode) => void;
  "kiosk:command": (env: CommandEnvelope) => void;
  "kiosk:state": (state: KioskState) => void; // forwarded to the phone
  "session:started": (info: SessionInfo) => void;
  "session:ended": (info: SessionInfo) => void;
  "agent:message": (msg: AgentMessage) => void;
  "debug:ping": (p: { from: string; text: string; at: number }) => void;
}

/** Events kiosks and phones send. */
export interface ClientToServerEvents {
  // kiosk
  "kiosk:register": (reg: KioskRegistration, done: (res: RegisterResult) => void) => void;
  "kiosk:state": (state: KioskState) => void;
  "kiosk:ack": (ack: CommandAck) => void;
  "kiosk:end-session": () => void; // staff pressed "End accessible session"
  // phone
  "user:message": (p: { text: string }) => void;
  "user:confirm": (p: { confirmed: boolean }) => void;
  "user:end-session": () => void;
  // both
  "debug:ping": (p: { text: string }) => void;
}

/** Handshake auth the phone sends when it connects. Kiosks send none and use kiosk:register. */
export interface PhoneAuth {
  role: "phone";
  sessionId: string;
  sessionSecret: string;
}

// ---------- REST ----------

/** Either the QR link's kioskId + token, or just the kiosk's fixed code (e.g. "FD48213"). */
export type CreateSessionRequest = { kioskId: string; token: string } | { code: string };

export interface CreateSessionResponse {
  sessionId: string;
  sessionSecret: string;
  kioskId: string;
}

export interface ApiError {
  error: "kiosk_busy" | "code_expired" | "kiosk_offline" | "bad_request" | "code_not_found" | "too_many_attempts";
  message: string;
}

// ---------- Event log ----------

export type LoggedEventType =
  | "kiosk_registered"
  | "session_start"
  | "session_end"
  | "user_message"
  | "agent_message"
  | "tool_call"
  | "command"
  | "error"
  | "checkout_requested"
  | "checkout_confirmed"
  | "order_complete";

export interface LoggedEvent {
  at: string; // ISO timestamp
  type: LoggedEventType;
  kioskId?: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

// ---------- Menu ----------

export interface MenuChoice {
  id: string;
  name: string;
  priceDelta: number;
}

export interface MenuOptionGroup {
  id: string;
  name: string;
  type: "single" | "multi";
  required: boolean;
  choices: MenuChoice[];
}

export interface MenuItem {
  id: string;
  categoryId: string;
  name: string;
  price: number;
  description: string;
  tags: string[];
  optionGroups: MenuOptionGroup[];
  upsell?: { text: string; itemId: string; priceDelta: number };
  /** Hidden items (like a combo upgrade) are only added through an upsell popup. */
  hidden?: boolean;
}

export interface Menu {
  categories: { id: string; name: string }[];
  items: MenuItem[];
  taxRate: number;
}
