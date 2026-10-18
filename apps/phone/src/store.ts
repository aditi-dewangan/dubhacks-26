import { create } from "zustand";
import type { KioskState, SessionEndReason } from "@kiosk-access/shared";
import type { PhoneProfile } from "./connection.ts";

export type AppPhase = "init" | "bad_url" | "connecting" | "error" | "active" | "ended";

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  awaitingConfirmation: boolean;
}

interface PhoneStore {
  phase: AppPhase;
  errorCode: string | null;
  errorMessage: string | null;
  messages: ChatMessage[];
  kioskState: KioskState | null;
  endReason: SessionEndReason | null;
  awaitingConfirmation: boolean;
  orderingStarted: boolean;
  speechRate: number;
  /** This phone's saved profile, once the server recognises it. */
  profile: PhoneProfile | null;

  setPhase(phase: AppPhase): void;
  setError(code: string, message: string): void;
  pushMessage(msg: ChatMessage): void;
  setKioskState(state: KioskState): void;
  setEnded(reason: SessionEndReason | null): void;
  setAwaitingConfirmation(v: boolean): void;
  setOrderingStarted(v: boolean): void;
  setSpeechRate(rate: number): void;
  setProfile(profile: PhoneProfile): void;
}

export const usePhone = create<PhoneStore>((set) => ({
  phase: "init",
  errorCode: null,
  errorMessage: null,
  messages: [],
  kioskState: null,
  endReason: null,
  awaitingConfirmation: false,
  orderingStarted: false,
  speechRate: 1.0,
  profile: null,

  setPhase: (phase) => set({ phase }),
  setError: (errorCode, errorMessage) => set({ phase: "error", errorCode, errorMessage }),
  pushMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  setKioskState: (kioskState) => set({ kioskState }),
  setEnded: (endReason) => set({ phase: "ended", endReason }),
  setAwaitingConfirmation: (awaitingConfirmation) => set({ awaitingConfirmation }),
  setOrderingStarted: (orderingStarted) => set({ orderingStarted }),
  setSpeechRate: (speechRate) => set({ speechRate }),
  setProfile: (profile) => set({ profile }),
}));
