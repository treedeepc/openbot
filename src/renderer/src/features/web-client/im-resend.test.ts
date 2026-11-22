import type { ImDelivery, ImMessage } from "@openbot/contracts/ipc";
import type { ImMessageRow } from "@openbot/team-client/im-client";
import { toImMessageRow } from "@openbot/team-client/im-client";
import {
  imAutoResendTargets,
  imResendable,
  imResendOnOnline,
  imSendPhase,
  imUndeliveredRows,
  imWithdrawn,
} from "@openbot/team-client/im-resend";
import { imUndeliveredHintKey } from "@openbot/ui/features/im/im-session";
import { describe, expect, it } from "vitest";

const message: ImMessage = {
  localMessageId: "msg-1",
  remoteMessageId: "remote-1",
  threadId: "thread-1",
  senderKind: "self",
  senderAgentId: null,
  deviceId: null,
  body: "上线后记得回我",
  attachments: [],
  replyTo: null,
  proxiedBy: null,
  proxyVisibility: null,
  causalChainId: null,
  sentAt: 1_700_000_000_000,
  expiresAt: 1_700_030_000_000,
  withdrawnAt: null,
  verified: false,
};

function deliveryWith(state: ImDelivery["state"], attempts: number, error: string | null = null): ImDelivery {
  return {
    deliveryId: "delivery-1",
    localMessageId: "msg-1",
    state,
    attempts,
    createdAt: 1_700_000_000_000,
    ackedAt: null,
    error,
  };
}

function rowWith(delivery: ImDelivery | undefined, withdrawn = false): ImMessageRow {
  return toImMessageRow({ ...message, withdrawnAt: withdrawn ? 1_700_000_060_000 : null }, delivery, "我自己");
}

describe("im resend policy", () => {
  it("keeps undelivered sends in the pending queue and drops everything else", () => {
    const undelivered = rowWith(deliveryWith("failed", 1, "im.notDelivered"));
    expect(imUndeliveredRows([undelivered])).toEqual([undelivered]);
    expect(imUndeliveredRows([rowWith(deliveryWith("persisted", 1))])).toEqual([]);
    expect(imUndeliveredRows([rowWith(deliveryWith("acked", 1))])).toEqual([]);
    expect(imUndeliveredRows([rowWith(deliveryWith("read", 1))])).toEqual([]);
    expect(imUndeliveredRows([rowWith(deliveryWith("blocked-discarded", 1))])).toEqual([]);
    expect(imUndeliveredRows([rowWith(deliveryWith("failed", 1), true)])).toEqual([]);
    expect(imUndeliveredRows([rowWith(undefined)])).toEqual([]);
  });

  it("refuses to resend delivered or withdrawn messages", () => {
    expect(imResendable(rowWith(deliveryWith("failed", 1)))).toBe(true);
    expect(imResendable(rowWith(deliveryWith("persisted", 2)))).toBe(false);
    expect(imResendable(rowWith(deliveryWith("acked", 2)))).toBe(false);
    expect(imResendable(rowWith(deliveryWith("read", 2)))).toBe(false);
    expect(imResendable(rowWith(deliveryWith("failed", 1), true))).toBe(false);
    expect(imResendable(rowWith(undefined))).toBe(false);
  });

  it("reads the resend lifecycle as not delivered, resending, delivered", () => {
    expect(imSendPhase(rowWith(deliveryWith("failed", 1)))).toBe("undelivered");
    expect(imSendPhase(rowWith(deliveryWith("failed", 3)))).toBe("undelivered");
    expect(imSendPhase(rowWith(deliveryWith("submitted", 2)))).toBe("resending");
    expect(imSendPhase(rowWith(deliveryWith("submitted", 1)))).toBe("settled");
    expect(imSendPhase(rowWith(deliveryWith("persisted", 2)))).toBe("delivered");
    expect(imSendPhase(rowWith(deliveryWith("acked", 2)))).toBe("delivered");
    expect(imSendPhase(rowWith(deliveryWith("read", 2)))).toBe("delivered");
    expect(imSendPhase(rowWith(deliveryWith("failed", 1), true))).toBe("withdrawn");
  });

  it("marks a resend in flight before the state machine moves", () => {
    expect(imSendPhase(rowWith(deliveryWith("failed", 1)), true)).toBe("resending");
    expect(imSendPhase(rowWith(deliveryWith("submitted", 1)), true)).toBe("resending");
    expect(imSendPhase(rowWith(deliveryWith("acked", 1)), true)).toBe("settled");
    expect(imSendPhase(rowWith(deliveryWith("failed", 1), true), true)).toBe("withdrawn");
  });

  it("reads a withdrawn send from the delivery state as well", () => {
    const withdrawnSend = rowWith(deliveryWith("blocked-discarded", 1, "im.messageWithdrawn"));
    expect(imWithdrawn(withdrawnSend)).toBe(true);
    expect(imSendPhase(withdrawnSend)).toBe("withdrawn");
    expect(imResendable(withdrawnSend)).toBe(false);
    expect(imUndeliveredRows([withdrawnSend])).toEqual([]);
    expect(imAutoResendTargets([withdrawnSend], "offline", "online")).toEqual([]);
    const blocked = rowWith(deliveryWith("blocked-discarded", 1, "im.peerBlocked"));
    expect(imWithdrawn(blocked)).toBe(false);
    expect(imSendPhase(blocked)).toBe("settled");
    expect(imWithdrawn(rowWith(deliveryWith("failed", 1), true))).toBe(true);
  });

  it("says the peer is offline for both offline error codes", () => {
    expect(imUndeliveredHintKey(rowWith(deliveryWith("failed", 1, "im.peerOffline")))).toBe(
      "im.message.undeliveredHint",
    );
    expect(imUndeliveredHintKey(rowWith(deliveryWith("failed", 1, "im.notDelivered")))).toBe(
      "im.message.undeliveredHint",
    );
    expect(imUndeliveredHintKey(rowWith(deliveryWith("failed", 1)))).toBe("im.message.undeliveredHint");
    expect(imUndeliveredHintKey(rowWith(deliveryWith("failed", 1, "im.lanDisabled")))).toBe("im.message.retryHint");
  });

  it("auto resends only when the peer comes online", async () => {
    const undelivered = rowWith(deliveryWith("failed", 1));
    const delivered = rowWith(deliveryWith("acked", 2));
    const withdrawn = rowWith(deliveryWith("failed", 1), true);
    const rows = [undelivered, delivered, withdrawn];
    expect(imAutoResendTargets(rows, "offline", "online")).toEqual([undelivered]);
    expect(imAutoResendTargets(rows, "away", "online")).toEqual([undelivered]);
    expect(imAutoResendTargets(rows, null, "online")).toEqual([undelivered]);
    expect(imAutoResendTargets(rows, "online", "online")).toEqual([]);
    expect(imAutoResendTargets(rows, null, "offline")).toEqual([]);
    expect(imAutoResendTargets(rows, "offline", "away")).toEqual([]);
    const resent: ImMessageRow[] = [];
    const sent = await imResendOnOnline(rows, "offline", "online", async (row) => {
      resent.push(row);
    });
    expect(sent).toEqual([undelivered]);
    expect(resent).toEqual([undelivered]);
    const again = await imResendOnOnline(rows, "online", "online", async (row) => {
      resent.push(row);
    });
    expect(again).toEqual([]);
    expect(resent).toEqual([undelivered]);
  });
});
