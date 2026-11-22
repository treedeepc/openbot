import type { DatabaseSync } from "node:sqlite";
import type { ImPage, ImSearchResult } from "@openbot/contracts/ipc";
import { databaseRows } from "../database/database-rows";
import { IM_RATE_LIMITS, ImRateLimiter, type ImSocialScope } from "./social";

export class ImSearchRateLimited extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("im.rateLimited");
    this.name = "ImSearchRateLimited";
    this.retryAfterMs = retryAfterMs;
  }
}

export class ImSearchService {
  readonly #db: DatabaseSync;
  readonly #localServerId: string;
  readonly #limiter: ImRateLimiter;

  constructor(db: DatabaseSync, localServerId: string) {
    this.#db = db;
    this.#localServerId = localServerId;
    this.#limiter = new ImRateLimiter(db);
  }

  scope(memberId: string): ImSocialScope {
    return { localServerId: this.#localServerId, localMemberId: memberId };
  }

  search(memberId: string, input: { q: string; cursor?: string; at: number }): ImPage<ImSearchResult> {
    const scope = this.scope(memberId);
    const decision = this.#limiter.peek({
      ...scope,
      actorId: memberId,
      action: "im.search",
      targetId: memberId,
      at: input.at,
      policy: IM_RATE_LIMITS.search,
    });
    if (!decision.allowed) throw new ImSearchRateLimited(decision.retryAfterMs);
    this.#limiter.record({
      ...scope,
      actorId: memberId,
      action: "im.search",
      targetId: memberId,
      at: input.at,
      policy: IM_RATE_LIMITS.search,
    });
    const needle = input.q.trim().toLowerCase();
    const rows = databaseRows(
      this.#db
        .prepare(
          `SELECT p.peer_server_id, p.peer_agent_id, p.display_name
           FROM peers p
           WHERE (LOWER(p.display_name) LIKE ? OR LOWER(p.peer_server_id) LIKE ? OR LOWER(p.peer_agent_id) LIKE ?)
             AND (
               EXISTS (SELECT 1 FROM im_threads t WHERE t.local_server_id = ? AND t.local_member_id = ?
                         AND t.peer_server_id = p.peer_server_id AND t.peer_agent_id = p.peer_agent_id)
               OR EXISTS (SELECT 1 FROM contacts c WHERE c.local_server_id = ? AND c.local_member_id = ?
                         AND c.peer_server_id = p.peer_server_id AND c.peer_agent_id = p.peer_agent_id)
             )
             AND NOT EXISTS (SELECT 1 FROM block_rules b WHERE b.local_server_id = ? AND b.local_member_id = ?
                         AND b.peer_server_id = p.peer_server_id AND b.peer_agent_id = p.peer_agent_id)
             AND NOT EXISTS (SELECT 1 FROM block_rules b2 WHERE b2.local_server_id = p.peer_server_id
                         AND b2.local_member_id = p.peer_agent_id AND b2.peer_server_id = ? AND b2.peer_agent_id = ?)
           ORDER BY p.peer_server_id, p.peer_agent_id`,
        )
        .all(
          `%${needle}%`,
          `%${needle}%`,
          `%${needle}%`,
          this.#localServerId,
          memberId,
          this.#localServerId,
          memberId,
          this.#localServerId,
          memberId,
          this.#localServerId,
          memberId,
        ),
    );
    const items = rows.map((row) => ({
      peerServerId: String(row.peer_server_id),
      peerAgentId: String(row.peer_agent_id),
      displayName: String(row.display_name),
      searchable: true,
    }));
    const cursor = input.cursor;
    const start = cursor ? items.findIndex((item) => `${item.peerServerId}/${item.peerAgentId}` > cursor) : 0;
    const from = start < 0 ? items.length : start;
    const kept = items.slice(from, from + 50);
    const last = kept.at(-1);
    return {
      items: kept,
      next: kept.length === 50 && last ? `${last.peerServerId}/${last.peerAgentId}` : null,
    };
  }
}
