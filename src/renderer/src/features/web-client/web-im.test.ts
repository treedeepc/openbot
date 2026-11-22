import type { ImDelivery, ImMessage } from "@openbot/contracts/ipc";
import {
  IM_BLOCKLIST_CAPABILITY,
  IM_CAPABILITIES,
  IM_CONTACTS_CAPABILITY,
  IM_DEVICES_CAPABILITY,
  IM_INBOX_CAPABILITY,
  IM_MESSAGES_CAPABILITY,
  IM_PEERS_CAPABILITY,
  IM_REPORT_CAPABILITY,
  imCapabilitiesThrough,
} from "@openbot/contracts/team-protocol/im-v1";
import {
  IM_CONTACT_REQUEST_TTL_MS,
  imContactViewState,
  imInboxMatches,
  imSetPrimary,
  imToggleAssignee,
  toImInboxRow,
} from "@openbot/team-client/im-client";
import { describe, expect, it } from "vitest";
import { imEntryAvailable, imEntrySupport, imMessageRows, imPanes, toImPeerSummary } from "./web-im";

const ADVERTISED_WITHOUT_IM = ["agent-tasks-v1", "agent-threads-v1", "storage-v1"];

function message(id: string, overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    localMessageId: id,
    remoteMessageId: `remote-${id}`,
    threadId: "thread-1",
    senderKind: "peer",
    senderAgentId: null,
    deviceId: null,
    body: "hello",
    attachments: [],
    replyTo: null,
    proxiedBy: null,
    proxyVisibility: null,
    causalChainId: null,
    sentAt: 1_700_000_000_000,
    expiresAt: 1_700_030_000_000,
    withdrawnAt: null,
    verified: true,
    ...overrides,
  };
}

function delivery(id: string, state: ImDelivery["state"], error: string | null = null): ImDelivery {
  return {
    deliveryId: `delivery-${id}`,
    localMessageId: id,
    state,
    attempts: 1,
    createdAt: 1_700_000_000_000,
    ackedAt: state === "acked" || state === "read" ? 1_700_000_001_000 : null,
    error,
  };
}

describe("im entry gate", () => {
  const HIDDEN = {
    inbox: false,
    contacts: false,
    session: false,
    devices: false,
    assign: false,
    block: false,
    report: false,
  };

  it("keeps every entry hidden while no im capability is registered", () => {
    const support = imEntrySupport(ADVERTISED_WITHOUT_IM);
    expect(IM_CAPABILITIES.some((capability) => ADVERTISED_WITHOUT_IM.includes(capability))).toBe(false);
    expect(support).toEqual(HIDDEN);
    expect(imEntryAvailable(support)).toBe(false);
  });

  it("opens the inbox entry only with inbox and peers capabilities", () => {
    expect(imEntrySupport([IM_INBOX_CAPABILITY])).toEqual({ ...HIDDEN, assign: true });
    expect(imEntrySupport([IM_INBOX_CAPABILITY, IM_PEERS_CAPABILITY])).toEqual({
      ...HIDDEN,
      inbox: true,
      assign: true,
    });
  });

  it("opens the session entry only with peers and messages capabilities", () => {
    expect(imEntrySupport([IM_MESSAGES_CAPABILITY])).toEqual(HIDDEN);
    expect(imEntrySupport([IM_PEERS_CAPABILITY, IM_MESSAGES_CAPABILITY])).toEqual({ ...HIDDEN, session: true });
  });

  it("gates the contacts entry on its own capability", () => {
    expect(imEntrySupport([IM_CONTACTS_CAPABILITY])).toEqual({ ...HIDDEN, contacts: true });
  });

  it("gates block and report entries on their own capabilities", () => {
    expect(imEntrySupport([IM_BLOCKLIST_CAPABILITY])).toEqual({ ...HIDDEN, block: true });
    expect(imEntrySupport([IM_REPORT_CAPABILITY])).toEqual({ ...HIDDEN, report: true });
    expect(imEntrySupport([IM_DEVICES_CAPABILITY])).toEqual({ ...HIDDEN, devices: true });
  });

  it("opens every entry once the p0 stage is registered", () => {
    const support = imEntrySupport(imCapabilitiesThrough("p0"));
    expect(support).toEqual({
      inbox: true,
      contacts: true,
      session: true,
      devices: true,
      assign: true,
      block: true,
      report: true,
    });
    expect(imEntryAvailable(support)).toBe(true);
  });
});

describe("im pane shape", () => {
  it("shows only the session pane while just peers and messages are registered", () => {
    expect(imPanes(imEntrySupport([IM_PEERS_CAPABILITY, IM_MESSAGES_CAPABILITY]))).toEqual(["session"]);
  });

  it("keeps inbox, contacts and devices out of the shape until their own capabilities land", () => {
    const panes = imPanes(imEntrySupport([IM_PEERS_CAPABILITY, IM_MESSAGES_CAPABILITY]));
    expect(panes).not.toContain("inbox");
    expect(panes).not.toContain("contacts");
    expect(panes).not.toContain("devices");
    expect(imPanes(imEntrySupport(imCapabilitiesThrough("p0")))).toEqual(["inbox", "contacts", "session", "devices"]);
  });
});

describe("im message rows", () => {
  it("takes delivery state from the delivery read-back of the same message", () => {
    const rows = imMessageRows(
      [message("msg-1"), message("msg-2", { senderKind: "self" })],
      [delivery("msg-1", "acked"), delivery("msg-2", "failed", "im.notDelivered")],
      () => "Mira",
    );
    expect(rows.map((row) => row.delivery)).toEqual(["acked", "failed"]);
    expect(rows[1]?.deliveryError).toBe("im.notDelivered");
  });

  it("leaves delivery state empty when the read-back has no row for the message", () => {
    const rows = imMessageRows([message("msg-1")], [], () => "Mira");
    expect(rows[0]?.delivery).toBeUndefined();
  });

  it("marks withdrawn messages and maps the peer summary", () => {
    const rows = imMessageRows([message("msg-1", { withdrawnAt: 1_700_000_002_000 })], [], () => "Mira");
    expect(rows[0]?.withdrawn).toBe(true);
    expect(
      toImPeerSummary({
        peerServerId: "server",
        peerAgentId: "mira",
        displayName: "Mira",
        verified: true,
        fingerprint: "4F2A",
      }),
    ).toEqual({ name: "Mira", verified: true, fingerprint: "4F2A" });
  });
});

describe("im inbox rows", () => {
  const firstAgent = { id: "agent-1", name: "前端工程师" };
  const secondAgent = { id: "agent-2", name: "测试工程师" };
  const agents = [firstAgent, secondAgent];
  const thread = {
    threadId: "thread-1",
    peerServerId: "peer-server",
    peerAgentId: "mira",
    assignees: ["agent-1", "agent-2"],
    primary: "agent-2",
    lastMessageAt: 1_700_000_000_000,
    unread: 3,
  };
  const peer = {
    peerServerId: "peer-server",
    peerAgentId: "mira",
    displayName: "Mira",
    verified: true,
    fingerprint: "4F2A",
  };

  it("maps unread count, last message and the proxied marker from the last message", () => {
    const row = toImInboxRow(thread, peer, message("msg-1", { body: "在吗", proxiedBy: "agent-2" }), agents);
    expect(row.unread).toBe(3);
    expect(row.lastMessage).toBe("在吗");
    expect(row.proxiedBy).toBe("agent-2");
    expect(row.assignees.map((item) => [item.name, item.primary])).toEqual([
      ["前端工程师", false],
      ["测试工程师", true],
    ]);
  });

  it("keeps the proxied marker empty when nothing was proxied", () => {
    expect(toImInboxRow(thread, peer, undefined, agents).proxiedBy).toBeNull();
  });

  it("filters rows per thread filter", () => {
    const assigned = toImInboxRow(thread, peer, undefined, agents);
    const unassigned = toImInboxRow({ ...thread, assignees: [], primary: null }, peer, undefined, agents);
    expect(imInboxMatches("all", assigned)).toBe(true);
    expect(imInboxMatches("unread", assigned)).toBe(true);
    expect(imInboxMatches("unread", { ...assigned, unread: 0 })).toBe(false);
    expect(imInboxMatches("assigned", assigned)).toBe(true);
    expect(imInboxMatches("assigned", unassigned)).toBe(false);
    expect(imInboxMatches("unassigned", unassigned)).toBe(true);
  });

  it("keeps a single primary when toggling assignees", () => {
    const toggled = imToggleAssignee([{ id: "agent-1", name: "前端工程师", primary: true }], secondAgent);
    expect(toggled.map((item) => item.primary)).toEqual([true, false]);
    const removed = imToggleAssignee(toggled, firstAgent);
    expect(removed.map((item) => item.id)).toEqual(["agent-2"]);
    expect(removed.every((item) => item.primary)).toBe(true);
    expect(imSetPrimary(toggled, "agent-2").map((item) => item.primary)).toEqual([false, true]);
  });
});

describe("im contact rows", () => {
  const contact = {
    contactId: "contact-1",
    peerServerId: "peer-server",
    peerAgentId: "mira",
    alias: null,
    addedAt: 1_700_000_000_000,
  };

  it("shows a request as pending until the seven day window passes", () => {
    expect(imContactViewState({ ...contact, state: "pending" }, contact.addedAt + 1)).toBe("pending");
    expect(imContactViewState({ ...contact, state: "pending" }, contact.addedAt + IM_CONTACT_REQUEST_TTL_MS)).toBe(
      "expired",
    );
  });

  it("keeps accepted and rejected states independent of the window", () => {
    expect(
      imContactViewState({ ...contact, state: "accepted" }, contact.addedAt + 10 * IM_CONTACT_REQUEST_TTL_MS),
    ).toBe("accepted");
    expect(imContactViewState({ ...contact, state: "removed" }, contact.addedAt + 1)).toBe("rejected");
  });
});
