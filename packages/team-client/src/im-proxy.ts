import { IM_LIMITS, type ImProxySettings } from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import type { ImProxySend } from "./im-client";

export const IM_PROXY_DEFAULT_BUDGET_USD = 20;

export type ImProxySendFailure = "budget" | "failed";

export interface ImProxyChoice {
  enabled: boolean;
  showMark: boolean;
}

export interface ImProxyMarked {
  proxiedBy: string | null;
  proxyVisibility?: ImProxySettings["visibility"] | null;
}

export function imProxyDefaults(): ImProxySettings {
  return { enabled: false, visibility: "shown", monthlyBudgetUsd: IM_PROXY_DEFAULT_BUDGET_USD };
}

export function imProxyBudgetUsd(value: number): number {
  if (!Number.isFinite(value)) return IM_PROXY_DEFAULT_BUDGET_USD;
  return Math.min(IM_LIMITS.monthlyBudgetUsd, Math.max(0, Math.round(value)));
}

export function imProxySendFor(choice: ImProxyChoice, senderId: string, selfSenderId: string): ImProxySend | undefined {
  if (!choice.enabled || senderId === selfSenderId) return undefined;
  return { proxiedBy: senderId, visibility: choice.showMark ? "shown" : "hidden" };
}

export function imProxyMarkVisible(message: ImProxyMarked): boolean {
  return message.proxiedBy !== null && message.proxyVisibility !== "hidden";
}

export function imProxySendFailure(error: unknown): ImProxySendFailure {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!(current instanceof Error)) return "failed";
    if (current.message.includes("im.budgetExceeded")) return "budget";
    current = current.cause;
  }
  return "failed";
}

export const IM_PROXY_SEND_FAILURE_LABEL = {
  budget: "im.proxy.budgetExceeded",
  failed: "im.send.failed",
} as const satisfies Record<ImProxySendFailure, AppTextKey>;
