import type { DatabaseSync } from "node:sqlite";
import type { ImChannelMember, ImChannelRole, ImPage } from "@openbot/contracts/ipc";
import { databaseRow, databaseRows } from "../database/database-rows";

export interface ImChannelScope {
  localServerId: string;
  localMemberId: string;
}

export interface ImChannelPeer {
  peerServerId: string;
  peerAgentId: string;
}

export const IM_CHANNEL_ROLE_LIST = ["admin", "member", "readonly"] as const;

export class ImChannelNotFound extends Error {
  constructor() {
    super("im.threadNotFound");
    this.name = "ImChannelNotFound";
  }
}

export class ImChannelForbidden extends Error {
  constructor() {
    super("im.notAdmin");
    this.name = "ImChannelForbidden";
  }
}

export class ImExternalCannotInvite extends Error {
  constructor() {
    super("im.unauthorized");
    this.name = "ImExternalCannotInvite";
  }
}

export class ImPeerUnverified extends Error {
  constructor() {
    super("im.notVerified");
    this.name = "ImPeerUnverified";
  }
}

function role(value: unknown): ImChannelRole {
  return value === "admin" ? "admin" : value === "readonly" ? "readonly" : "member";
}

export class ImChannelRoles {
  readonly #db: DatabaseSync;
  readonly #localServerId: string;

  constructor(db: DatabaseSync, localServerId: string) {
    this.#db = db;
    this.#localServerId = localServerId;
  }

  list(memberId: string, channelId: string): ImPage<ImChannelMember> {
    const items = databaseRows(
      this.#db
        .prepare(
          `SELECT channel_id, peer_server_id, peer_agent_id, role FROM im_channel_members
           WHERE local_server_id = ? AND local_member_id = ? AND channel_id = ?
           ORDER BY peer_server_id, peer_agent_id`,
        )
        .all(this.#localServerId, memberId, channelId),
    ).map((row) => ({
      channelId: String(row.channel_id),
      peerServerId: String(row.peer_server_id),
      peerAgentId: String(row.peer_agent_id),
      role: role(row.role),
    }));
    return { items, next: null };
  }

  roleOf(memberId: string, channelId: string, peer: ImChannelPeer): ImChannelRole | null {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT role FROM im_channel_members WHERE local_server_id = ? AND local_member_id = ? AND channel_id = ? AND peer_server_id = ? AND peer_agent_id = ?",
        )
        .get(this.#localServerId, memberId, channelId, peer.peerServerId, peer.peerAgentId),
    );
    return row ? role(row.role) : null;
  }

  add(
    memberId: string,
    input: {
      channelId: string;
      peer: ImChannelPeer;
      role: ImChannelRole;
      addedBy: ImChannelPeer;
      at: number;
      verified?: boolean;
    },
  ): ImChannelMember {
    this.#assertCanInvite(memberId, input.channelId, input.addedBy);
    if (input.verified === false) throw new ImPeerUnverified();
    this.#db
      .prepare(
        `INSERT INTO im_channel_members (local_server_id, local_member_id, channel_id, peer_server_id, peer_agent_id,
          role, added_by, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(local_server_id, local_member_id, channel_id, peer_server_id, peer_agent_id)
           DO UPDATE SET role = excluded.role`,
      )
      .run(
        this.#localServerId,
        memberId,
        input.channelId,
        input.peer.peerServerId,
        input.peer.peerAgentId,
        input.role,
        `${input.addedBy.peerServerId}/${input.addedBy.peerAgentId}`,
        input.at,
      );
    return {
      channelId: input.channelId,
      peerServerId: input.peer.peerServerId,
      peerAgentId: input.peer.peerAgentId,
      role: input.role,
    };
  }

  changeRole(
    memberId: string,
    input: { channelId: string; peer: ImChannelPeer; role: ImChannelRole; by: ImChannelPeer },
  ): ImChannelMember {
    this.#assertAdmin(memberId, input.channelId, input.by);
    const current = this.roleOf(memberId, input.channelId, input.peer);
    if (current === null) throw new ImChannelNotFound();
    if (current === "admin" && input.role !== "admin" && this.#adminCount(memberId, input.channelId) <= 1) {
      throw new ImChannelForbidden();
    }
    this.#db
      .prepare(
        `UPDATE im_channel_members SET role = ?
         WHERE local_server_id = ? AND local_member_id = ? AND channel_id = ? AND peer_server_id = ? AND peer_agent_id = ?`,
      )
      .run(input.role, this.#localServerId, memberId, input.channelId, input.peer.peerServerId, input.peer.peerAgentId);
    return {
      channelId: input.channelId,
      peerServerId: input.peer.peerServerId,
      peerAgentId: input.peer.peerAgentId,
      role: input.role,
    };
  }

  remove(memberId: string, input: { channelId: string; peer: ImChannelPeer; by: ImChannelPeer }): boolean {
    this.#assertAdmin(memberId, input.channelId, input.by);
    const current = this.roleOf(memberId, input.channelId, input.peer);
    if (current === null) throw new ImChannelNotFound();
    if (current === "admin" && this.#adminCount(memberId, input.channelId) <= 1) throw new ImChannelForbidden();
    return (
      this.#db
        .prepare(
          `DELETE FROM im_channel_members
           WHERE local_server_id = ? AND local_member_id = ? AND channel_id = ? AND peer_server_id = ? AND peer_agent_id = ?`,
        )
        .run(this.#localServerId, memberId, input.channelId, input.peer.peerServerId, input.peer.peerAgentId).changes >
      0
    );
  }

  addByMember(
    memberId: string,
    input: { channelId: string; peer: ImChannelPeer; role: ImChannelRole; at: number; verified?: boolean },
  ): ImChannelMember {
    return this.add(memberId, { ...input, addedBy: this.self(memberId) });
  }

  removeByMember(memberId: string, input: { channelId: string; peer: ImChannelPeer }): boolean {
    return this.remove(memberId, { ...input, by: this.self(memberId) });
  }

  changeRoleByMember(
    memberId: string,
    input: { channelId: string; peer: ImChannelPeer; role: ImChannelRole },
  ): ImChannelMember {
    return this.changeRole(memberId, { ...input, by: this.self(memberId) });
  }

  self(memberId: string): ImChannelPeer {
    return { peerServerId: this.#localServerId, peerAgentId: memberId };
  }

  #assertCanInvite(memberId: string, channelId: string, by: ImChannelPeer): void {
    const acting = this.roleOf(memberId, channelId, by);
    if (this.#memberCount(memberId, channelId) === 0) return;
    if (acting === "admin") return;
    if (acting === "member" || acting === "readonly") throw new ImExternalCannotInvite();
    throw new ImChannelForbidden();
  }

  #assertAdmin(memberId: string, channelId: string, by: ImChannelPeer): void {
    if (this.roleOf(memberId, channelId, by) !== "admin") throw new ImChannelForbidden();
  }

  #memberCount(memberId: string, channelId: string): number {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT COUNT(*) AS n FROM im_channel_members WHERE local_server_id = ? AND local_member_id = ? AND channel_id = ?",
        )
        .get(this.#localServerId, memberId, channelId),
    );
    return row ? Number(row.n) : 0;
  }

  #adminCount(memberId: string, channelId: string): number {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT COUNT(*) AS n FROM im_channel_members WHERE local_server_id = ? AND local_member_id = ? AND channel_id = ? AND role = 'admin'",
        )
        .get(this.#localServerId, memberId, channelId),
    );
    return row ? Number(row.n) : 0;
  }
}
