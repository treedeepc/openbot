import {
  IM_PROXY_DEFAULT_BUDGET_USD,
  IM_PROXY_SEND_FAILURE_LABEL,
  imProxyBudgetUsd,
  imProxyDefaults,
  imProxyMarkVisible,
  imProxySendFailure,
  imProxySendFor,
} from "@openbot/team-client/im-proxy";
import { describe, expect, it } from "vitest";

describe("im proxy policy", () => {
  it("starts with replies off, the mark on and a 20 dollar budget", () => {
    expect(imProxyDefaults()).toEqual({ enabled: false, visibility: "shown", monthlyBudgetUsd: 20 });
    expect(IM_PROXY_DEFAULT_BUDGET_USD).toBe(20);
    expect(IM_PROXY_SEND_FAILURE_LABEL.budget).toBe("im.proxy.budgetExceeded");
    expect(IM_PROXY_SEND_FAILURE_LABEL.failed).toBe("im.send.failed");
  });

  it("keeps who answered even when the mark is hidden", () => {
    const shown = imProxySendFor({ enabled: true, showMark: true }, "agent-1", "self");
    expect(shown).toEqual({ proxiedBy: "agent-1", visibility: "shown" });
    const hidden = imProxySendFor({ enabled: true, showMark: false }, "agent-1", "self");
    expect(hidden).toEqual({ proxiedBy: "agent-1", visibility: "hidden" });
    expect(hidden?.proxiedBy).toBe("agent-1");
  });

  it("never marks a send that is not proxied", () => {
    expect(imProxySendFor({ enabled: false, showMark: true }, "agent-1", "self")).toBeUndefined();
    expect(imProxySendFor({ enabled: true, showMark: true }, "self", "self")).toBeUndefined();
  });

  it("shows the mark per message from its own visibility", () => {
    expect(imProxyMarkVisible({ proxiedBy: "agent-1", proxyVisibility: "shown" })).toBe(true);
    expect(imProxyMarkVisible({ proxiedBy: "agent-1", proxyVisibility: null })).toBe(true);
    expect(imProxyMarkVisible({ proxiedBy: "agent-1", proxyVisibility: "hidden" })).toBe(false);
    expect(imProxyMarkVisible({ proxiedBy: null, proxyVisibility: "shown" })).toBe(false);
    expect(imProxyMarkVisible({ proxiedBy: null })).toBe(false);
  });

  it("clamps the budget to the contract limits", () => {
    expect(imProxyBudgetUsd(20)).toBe(20);
    expect(imProxyBudgetUsd(55.4)).toBe(55);
    expect(imProxyBudgetUsd(-3)).toBe(0);
    expect(imProxyBudgetUsd(5_000)).toBe(1_000);
    expect(imProxyBudgetUsd(Number.NaN)).toBe(20);
  });

  it("tells a refused send from an ordinary failure", () => {
    expect(imProxySendFailure(new Error("im.budgetExceeded"))).toBe("budget");
    expect(imProxySendFailure(new Error("boom", { cause: new Error("im.budgetExceeded") }))).toBe("budget");
    expect(imProxySendFailure(new Error("im.notDelivered"))).toBe("failed");
    expect(imProxySendFailure(new Error("boom", { cause: new Error("boom") }))).toBe("failed");
    expect(imProxySendFailure("im.budgetExceeded")).toBe("failed");
    expect(imProxySendFailure(undefined)).toBe("failed");
  });
});
