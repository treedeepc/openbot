import type { ImChannelMember, ImPeer } from "@openbot/contracts/ipc";
import type { ImChannelMemberRow } from "@openbot/team-client/im-client";
import { describe, expect, it } from "vitest";
import { IM_MUTE_WINDOW_MS, imChannelCanInvite, imChannelInviteTargets, imMuteToggle } from "./im-port";

const ROWS: readonly ImChannelMemberRow[] = [
  { id: "peer-server/mira", name: "Mira", role: "admin", external: false },
  { id: "peer-server/sam", name: "Sam", role: "member", external: false },
  { id: "third-server/kite", name: "Kite", role: "readonly", external: true },
];

const PEERS: readonly ImPeer[] = [
  { peerServerId: "peer-server", peerAgentId: "mira", displayName: "Mira", verified: true, fingerprint: "4F2A" },
  { peerServerId: "peer-server", peerAgentId: "sam", displayName: "Sam", verified: true, fingerprint: "7B60" },
  { peerServerId: "third-server", peerAgentId: "kite", displayName: "Kite", verified: false, fingerprint: "" },
];

const MEMBERS: readonly ImChannelMember[] = [
  { channelId: "thread-1", peerServerId: "peer-server", peerAgentId: "mira", role: "admin" },
  { channelId: "thread-1", peerServerId: "peer-server", peerAgentId: "sam", role: "member" },
];

describe("im channel permissions", () => {
  it("lets an internal admin invite and refuses everyone else", () => {
    expect(imChannelCanInvite(ROWS, { peerServerId: "peer-server", peerAgentId: "mira" })).toBe(true);
    expect(imChannelCanInvite(ROWS, { peerServerId: "peer-server", peerAgentId: "sam" })).toBe(false);
    expect(imChannelCanInvite(ROWS, { peerServerId: "third-server", peerAgentId: "kite" })).toBe(false);
  });

  it("treats a viewer with no member row as the channel owner", () => {
    expect(imChannelCanInvite(ROWS, null)).toBe(true);
    expect(imChannelCanInvite(ROWS, { peerServerId: "peer-server", peerAgentId: "nobody" })).toBe(true);
  });

  it("offers only peers that are not members yet", () => {
    const targets = imChannelInviteTargets(PEERS, MEMBERS);
    expect(targets.map((peer) => `${peer.peerServerId}/${peer.peerAgentId}`)).toEqual(["third-server/kite"]);
    const everyone = [
      ...MEMBERS,
      { channelId: "thread-1", peerServerId: "third-server", peerAgentId: "kite", role: "readonly" as const },
    ];
    expect(imChannelInviteTargets(PEERS, everyone)).toEqual([]);
  });
});

describe("im mute window", () => {
  it("mutes for one window and clears on the next toggle", () => {
    const until = imMuteToggle(null, 1_700_000_000_000);
    expect(until).toBe(1_700_000_000_000 + IM_MUTE_WINDOW_MS);
    expect(IM_MUTE_WINDOW_MS).toBe(8 * 3_600_000);
    expect(imMuteToggle(until, 1_700_000_100_000)).toBeNull();
  });
});
