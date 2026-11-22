import {
  parseImDeviceId,
  parseImEnrollApprove,
  parseImMessageList,
  parseImPresenceQuery,
  parseImReportCreate,
  parseImSendMessage,
} from "@openbot/contracts/ipc";
import { IM_ROUTES } from "@openbot/contracts/team-protocol/im-v1";
import type { ImHostPort } from "@openbot/team-client/im-client";
import { imHostPort } from "@openbot/team-client/im-host-port";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { describe, expect, it } from "vitest";
import { createMockIm } from "../../preview/mock-im";
import { mockImPort } from "../../preview/mock-im-port";

interface Call {
  path: string;
  body: unknown;
}

function stubPort(calls: Call[], reply: (path: string, body: unknown) => unknown): ImHostPort {
  const request: TeamApiRequest = async (_method, path, decode, body) => {
    calls.push({ path, body });
    return decode(reply(path, body));
  };
  return imHostPort({ request: () => request, newRemoteMessageId: () => "remote-fixed" });
}

async function plainSend(port: ImHostPort, calls: Call[]): Promise<Call> {
  const before = calls.length;
  await port.messages.send("thread-1", "myself");
  const call = calls[before];
  if (!call) throw new Error("missing call");
  return call;
}

function keysOf(body: unknown): string[] {
  return body === null || typeof body !== "object" ? [] : Object.keys(body).sort();
}

function surface(port: ImHostPort): string[] {
  return Object.entries(port)
    .flatMap(([group, methods]) =>
      methods === null || typeof methods !== "object"
        ? []
        : Object.entries(methods)
            .filter(([, value]) => typeof value === "function")
            .map(([name]) => `${group}.${name}`),
    )
    .sort();
}

describe("im host port", () => {
  it("exposes the same port surface as the mock port", () => {
    expect(surface(stubPort([], () => ({})))).toEqual(surface(mockImPort(createMockIm())));
  });

  it("posts every ui call to a frozen im route", async () => {
    const calls: Call[] = [];
    const port = stubPort(calls, (path) => {
      if (path === IM_ROUTES.peersList) return { items: [], next: null };
      if (path === IM_ROUTES.threadsList) return { items: [], next: null };
      if (path === IM_ROUTES.messagesList) return { items: [], next: null };
      if (path === IM_ROUTES.contactsList) return { items: [], next: null };
      if (path === IM_ROUTES.blocklistList) return { items: [], next: null };
      if (path === IM_ROUTES.enrollBegin)
        return {
          deviceId: "device-1",
          pairingCode: "1234-5678",
          fingerprint: "iPhone",
          expiresAt: 1_700_000_900_000,
        };
      if (path === IM_ROUTES.messageSend) return message;
      if (path === IM_ROUTES.messageWithdraw) return { withdrawn: true };
      if (path === IM_ROUTES.deliveryList) return { items: [], next: null };
      if (path === IM_ROUTES.deliveryResend) return delivery;
      if (path === IM_ROUTES.threadAssign) return thread;
      if (path === IM_ROUTES.devicesList) return { items: [], next: null };
      if (path === IM_ROUTES.deviceRevoke) return device;
      return null;
    });
    await port.peers.list();
    await port.threads.list();
    await port.threads.assign("thread-1", ["agent-1"], "agent-1");
    await port.messages.list("thread-1");
    await port.messages.send("thread-1", "hello");
    await port.delivery.list("thread-1");
    await port.devices.list();
    await port.devices.enrollBegin("iPhone", "ed25519:aa");
    await port.devices.enrollApprove("device-1", "1234-5678");
    await port.devices.revoke("device-1");
    await port.contacts.list();
    await port.contacts.request({ peerServerId: "peer-server", peerAgentId: "mira" });
    await port.contacts.accept("contact-1");
    await port.contacts.reject("contact-1");
    await port.blocklist.list();
    await port.blocklist.add({ peerServerId: "peer-server", peerAgentId: "mira" });
    await port.reports.create("peer-server/mira", "spam");
    await port.messages.withdraw("thread-1", "msg-1");
    await port.delivery.list("thread-1");
    await port.delivery.read("thread-1", "msg-1");
    await port.delivery.resend("delivery-1");
    expect(new Set(calls.map((call) => call.path))).toEqual(
      new Set([
        IM_ROUTES.peersList,
        IM_ROUTES.threadsList,
        IM_ROUTES.threadAssign,
        IM_ROUTES.messagesList,
        IM_ROUTES.messageSend,
        IM_ROUTES.devicesList,
        IM_ROUTES.enrollBegin,
        IM_ROUTES.enrollApprove,
        IM_ROUTES.deviceRevoke,
        IM_ROUTES.contactsList,
        IM_ROUTES.contactRequest,
        IM_ROUTES.contactAccept,
        IM_ROUTES.contactReject,
        IM_ROUTES.blocklistList,
        IM_ROUTES.blocklistAdd,
        IM_ROUTES.reportCreate,
        IM_ROUTES.messageWithdraw,
        IM_ROUTES.deliveryList,
        IM_ROUTES.deliveryRead,
        IM_ROUTES.deliveryResend,
      ]),
    );
  });

  it("sends request bodies the contract parsers accept", async () => {
    const calls: Call[] = [];
    const port = stubPort(calls, (path) => {
      if (path === IM_ROUTES.messageSend) return message;
      if (path === IM_ROUTES.messageWithdraw) return { withdrawn: true };
      if (path === IM_ROUTES.deliveryList) return { items: [], next: null };
      if (path === IM_ROUTES.deliveryResend) return delivery;
      return { items: [], next: null };
    });
    await port.messages.list("thread-1");
    await port.messages.send("thread-1", "hello");
    await port.contacts.request({ peerServerId: "peer-server", peerAgentId: "mira" });
    await port.blocklist.add({ peerServerId: "peer-server", peerAgentId: "mira" });
    await port.reports.create("peer-server/mira", "abuse");
    await port.devices.enrollApprove("device-1", "1234-5678");
    expect(parseImMessageList(calls[0]?.body).threadId).toBe("thread-1");
    const sent = parseImSendMessage(calls[1]?.body);
    expect([sent.threadId, sent.remoteMessageId, sent.body]).toEqual(["thread-1", "remote-fixed", "hello"]);
    expect(keysOf(calls[2]?.body)).toEqual(["note", "peerAgentId", "peerServerId"]);
    expect(keysOf(calls[3]?.body)).toEqual(["peerAgentId", "peerServerId", "reason"]);
    expect(parseImReportCreate(calls[4]?.body)).toMatchObject({
      targetPeer: "peer-server/mira",
      category: "abuse",
    });
    expect(parseImEnrollApprove(calls[5]?.body)).toEqual({ deviceId: "device-1", pairingCode: "1234-5678" });
  });

  it("decodes replies with the contract decoders", async () => {
    const port = stubPort([], (path) =>
      path === IM_ROUTES.peersList ? { items: [peer], next: null } : { items: [thread], next: null },
    );
    const peers = await port.peers.list();
    expect(peers.items[0]?.displayName).toBe("Mira");
    const threads = await port.threads.list();
    expect(threads.items[0]?.threadId).toBe("thread-1");
  });

  it("drives the whole device surface over its six real routes", async () => {
    const calls: Call[] = [];
    const port = stubPort(calls, (path) => {
      if (path === IM_ROUTES.devicesList) return { items: [device], next: null };
      if (path === IM_ROUTES.enrollBegin)
        return {
          deviceId: "device-1",
          pairingCode: "1234-5678",
          fingerprint: "iPhone",
          expiresAt: 1_700_000_900_000,
        };
      return device;
    });
    await port.devices.list();
    await port.devices.enrollBegin("iPhone", "ed25519:aa");
    await port.devices.enrollApprove("device-1", "1234-5678");
    await port.devices.enrollStatus("device-1");
    await port.devices.enrollCancel("device-1");
    await port.devices.revoke("device-1");
    expect(calls.map((call) => call.path)).toEqual([
      IM_ROUTES.devicesList,
      IM_ROUTES.enrollBegin,
      IM_ROUTES.enrollApprove,
      IM_ROUTES.enrollStatus,
      IM_ROUTES.enrollCancel,
      IM_ROUTES.deviceRevoke,
    ]);
    expect(parseImDeviceId(calls[3]?.body)).toEqual({ deviceId: "device-1" });
    expect(parseImDeviceId(calls[4]?.body)).toEqual({ deviceId: "device-1" });
  });

  it("reads peer presence over its frozen route", async () => {
    const calls: Call[] = [];
    const port = stubPort(calls, () => ({ items: [presence], next: null }));
    const page = await port.presence.list([{ peerServerId: "peer-server", peerAgentId: "mira" }]);
    expect(calls.map((call) => call.path)).toEqual([IM_ROUTES.presenceGet]);
    expect(parseImPresenceQuery(calls[0]?.body)).toEqual({
      peers: [{ peerServerId: "peer-server", peerAgentId: "mira" }],
    });
    expect(page.items[0]?.state).toBe("online");
  });

  it("carries the proxy marker and its visibility on a proxied send", async () => {
    const calls: Call[] = [];
    const port = stubPort(calls, () => message);
    await port.messages.send("thread-1", "on your behalf", { proxiedBy: "agent-1", visibility: "hidden" });
    const sent = parseImSendMessage(calls[0]?.body);
    expect(sent.proxiedBy).toBe("agent-1");
    expect(sent.proxyVisibility).toBe("hidden");
    expect(parseImSendMessage((await plainSend(port, calls)).body).proxiedBy).toBeNull();
  });

  it("reads delivery state back and drives read and resend over their routes", async () => {
    const calls: Call[] = [];
    const port = stubPort(calls, (path) => (path === IM_ROUTES.deliveryList ? { items: [], next: null } : delivery));
    await port.delivery.list("thread-1");
    await port.delivery.read("thread-1", "msg-1");
    await port.delivery.resend("delivery-1");
    await port.messages.withdraw("thread-1", "msg-1");
    expect(calls.map((call) => call.path)).toEqual([
      IM_ROUTES.deliveryList,
      IM_ROUTES.deliveryRead,
      IM_ROUTES.deliveryResend,
      IM_ROUTES.messageWithdraw,
    ]);
  });
});

const peer = {
  peerServerId: "peer-server",
  peerAgentId: "mira",
  displayName: "Mira",
  verified: true,
  fingerprint: "4F2A",
};

const thread = {
  threadId: "thread-1",
  peerServerId: "peer-server",
  peerAgentId: "mira",
  assignees: [],
  primary: null,
  lastMessageAt: 1_700_000_000_000,
  unread: 0,
};

const message = {
  localMessageId: "msg-1",
  remoteMessageId: "remote-1",
  threadId: "thread-1",
  senderKind: "self",
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
  verified: false,
};

const delivery = {
  deliveryId: "delivery-1",
  localMessageId: "msg-1",
  state: "submitted",
  attempts: 1,
  createdAt: 1_700_000_000_000,
  ackedAt: null,
  error: null,
};

const device = {
  deviceId: "device-1",
  publicKey: "ed25519:aa",
  status: "active",
  enrolledAt: 1_700_000_000_000,
  certExpiresAt: 1_790_000_000_000,
};

const presence = {
  peerServerId: "peer-server",
  peerAgentId: "mira",
  state: "online",
};
