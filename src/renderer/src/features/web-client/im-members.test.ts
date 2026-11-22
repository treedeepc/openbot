import { describe, expect, it } from "vitest";
import { createMockIm } from "../../preview/mock-im";
import { mockImPort } from "../../preview/mock-im-port";
import { toImChannelMemberRow } from "./web-im";

const admin = { channelId: "thread-1", peerServerId: "peer-server", peerAgentId: "mira", role: "admin" as const };
const readonlyMember = {
  channelId: "thread-1",
  peerServerId: "peer-server",
  peerAgentId: "kite",
  role: "readonly" as const,
};
const members = [
  { channelId: "thread-1", peerServerId: "peer-server", peerAgentId: "mira", role: "admin" as const },
  { channelId: "thread-1", peerServerId: "peer-server", peerAgentId: "kite", role: "readonly" as const },
];

describe("im channel members", () => {
  it("stage 1: the port returns the seeded members", async () => {
    const port = mockImPort(createMockIm(), { channelMembers: members });
    const page = await port.channels.listMembers("thread-1");
    expect(page.items).toHaveLength(2);
  });

  it("stage 2: the mapping keeps id, name and role", async () => {
    const mock = createMockIm({
      peers: [
        {
          peerServerId: "peer-server",
          peerAgentId: "mira",
          displayName: "Mira",
          verified: true,
          fingerprint: "4F2A",
        },
      ],
    });
    const peers = (await mock.peers.list()).items;
    const row = toImChannelMemberRow(admin, peers, () => true);
    expect([row.id, row.name, row.role, row.external]).toEqual(["peer-server/mira", "Mira", "admin", true]);
    const unknown = toImChannelMemberRow(readonlyMember, peers, () => true);
    expect(unknown.name).toBe("peer-server/kite");
  });
});
