import type { DatabaseSync } from "node:sqlite";
import type { ImBlockRule, ImContact, ImPage, ImReport, ImThread } from "@openbot/contracts/ipc";
import { databaseRow, databaseRows } from "../database/database-rows";
import { ImPrimaryChain, ImThreadUnknown } from "./proxy";
import {
  ImBlockStore,
  ImContactNotFound,
  ImContactRequestStore,
  ImContactStore,
  type ImReportCategory,
  ImReportStore,
  type ImSocialScope,
} from "./social";

export interface ImInboxPeer {
  peerServerId: string;
  peerAgentId: string;
}

export class ImInboxService {
  readonly #db: DatabaseSync;
  readonly #localServerId: string;
  readonly contacts: ImContactStore;
  readonly requests: ImContactRequestStore;
  readonly blocks: ImBlockStore;
  readonly reports: ImReportStore;
  readonly chain: ImPrimaryChain;

  constructor(db: DatabaseSync, localServerId: string) {
    this.#db = db;
    this.#localServerId = localServerId;
    this.contacts = new ImContactStore(db);
    this.requests = new ImContactRequestStore(db);
    this.blocks = new ImBlockStore(db);
    this.reports = new ImReportStore(db);
    this.chain = new ImPrimaryChain(db);
  }

  scope(memberId: string): ImSocialScope {
    return { localServerId: this.#localServerId, localMemberId: memberId };
  }

  listThreads(memberId: string, input: { cursor?: string } = {}): ImPage<ImThread> {
    const rows = databaseRows(
      this.#db
        .prepare(
          "SELECT thread_id, peer_server_id, peer_agent_id, last_message_at FROM im_threads WHERE local_server_id = ? AND local_member_id = ? ORDER BY thread_id",
        )
        .all(this.#localServerId, memberId),
    );
    const items = rows.map((row) => this.#thread(memberId, String(row.thread_id)));
    const cursor = input.cursor;
    const start = cursor ? items.findIndex((item) => item.threadId > cursor) : 0;
    const from = start < 0 ? items.length : start;
    const kept = items.slice(from, from + 50);
    const last = kept.at(-1);
    return { items: kept, next: kept.length === 50 && last ? last.threadId : null };
  }

  getThread(memberId: string, input: { threadId: string }): ImThread {
    return this.#thread(memberId, input.threadId);
  }

  assignThread(memberId: string, input: { threadId: string; assignees: string[]; primary: string }): ImThread {
    const scope = this.scope(memberId);
    this.#requireThread(scope, input.threadId);
    for (const agentId of input.assignees) {
      this.chain.assign(scope, input.threadId, agentId, agentId === input.primary ? "primary" : "assist");
    }
    for (const assignee of this.chain.assignees(scope, input.threadId)) {
      if (!input.assignees.includes(assignee.agentId)) this.chain.remove(scope, input.threadId, assignee.agentId);
    }
    return this.#thread(memberId, input.threadId);
  }

  transferThread(memberId: string, input: { threadId: string; toAgent: string }): ImThread {
    const scope = this.scope(memberId);
    const current = this.chain.primary(scope, input.threadId);
    if (current === null) throw new ImThreadUnknown();
    this.chain.transfer(scope, input.threadId, current, input.toAgent);
    return this.#thread(memberId, input.threadId);
  }

  listContacts(memberId: string): ImPage<ImContact> {
    const items = this.contacts.list(this.scope(memberId)).map(toContact);
    return { items, next: null };
  }

  requestContact(
    memberId: string,
    input: { contactId: string; peer: ImInboxPeer; note?: string | null; at: number },
  ): ImContact {
    return toContact(
      this.contacts.request({
        ...this.scope(memberId),
        contactId: input.contactId,
        peer: input.peer,
        source: input.note ?? null,
        at: input.at,
      }),
    );
  }

  acceptContact(memberId: string, input: { contactId: string; at: number }): ImContact {
    return toContact(
      this.contacts.accept({
        ...this.scope(memberId),
        peer: this.#peerOfContact(memberId, input.contactId),
        at: input.at,
      }),
    );
  }

  rejectContact(memberId: string, input: { contactId: string; at: number }): ImContact {
    return toContact(
      this.contacts.remove({
        ...this.scope(memberId),
        peer: this.#peerOfContact(memberId, input.contactId),
        at: input.at,
      }),
    );
  }

  removeContact(memberId: string, input: { contactId: string; at: number }): ImContact {
    return toContact(
      this.contacts.remove({
        ...this.scope(memberId),
        peer: this.#peerOfContact(memberId, input.contactId),
        at: input.at,
      }),
    );
  }

  listBlocklist(memberId: string): ImPage<ImBlockRule> {
    const items = this.blocks.list(this.scope(memberId)).map((rule) => ({
      ruleId: rule.ruleId,
      peerServerId: rule.peerServerId,
      peerAgentId: rule.peerAgentId,
      createdAt: rule.createdAt,
      reason: rule.reason,
    }));
    return { items, next: null };
  }

  addBlock(
    memberId: string,
    input: { ruleId: string; peer: ImInboxPeer; reason?: string | null; at: number },
  ): ImBlockRule {
    const rule = this.blocks.add({
      ...this.scope(memberId),
      ruleId: input.ruleId,
      peer: input.peer,
      reason: input.reason ?? null,
      at: input.at,
    });
    return {
      ruleId: rule.ruleId,
      peerServerId: rule.peerServerId,
      peerAgentId: rule.peerAgentId,
      createdAt: rule.createdAt,
      reason: rule.reason,
    };
  }

  removeBlock(memberId: string, input: { peer: ImInboxPeer }): boolean {
    return this.blocks.remove({ ...this.scope(memberId), peer: input.peer });
  }

  createReport(
    memberId: string,
    input: { reportId: string; targetPeer: string; category: ImReportCategory; detail?: string | null; at: number },
  ): ImReport {
    return toReport(
      this.reports.create({
        ...this.scope(memberId),
        reportId: input.reportId,
        targetPeer: input.targetPeer,
        category: input.category,
        detail: input.detail ?? null,
        at: input.at,
      }),
    );
  }

  listReports(memberId: string): ImPage<ImReport> {
    return { items: this.reports.list(this.scope(memberId)).map(toReport), next: null };
  }

  #thread(memberId: string, threadId: string): ImThread {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT thread_id, peer_server_id, peer_agent_id, last_message_at FROM im_threads WHERE local_server_id = ? AND local_member_id = ? AND thread_id = ?",
        )
        .get(this.#localServerId, memberId, threadId),
    );
    if (!row) throw new ImThreadUnknown();
    const scope = this.scope(memberId);
    const assignees = this.chain.assignees(scope, threadId);
    return {
      threadId: String(row.thread_id),
      peerServerId: String(row.peer_server_id),
      peerAgentId: String(row.peer_agent_id),
      assignees: assignees.map((assignee) => assignee.agentId),
      primary: this.chain.primary(scope, threadId),
      lastMessageAt: row.last_message_at === null ? null : Number(row.last_message_at),
      unread: Number(
        databaseRow(
          this.#db
            .prepare(
              "SELECT COUNT(*) AS n FROM im_messages WHERE local_server_id = ? AND local_member_id = ? AND thread_id = ?",
            )
            .get(this.#localServerId, memberId, threadId),
        )?.n ?? 0,
      ),
    };
  }

  #requireThread(scope: ImSocialScope, threadId: string): void {
    this.#thread(scope.localMemberId, threadId);
  }

  #peerOfContact(memberId: string, contactId: string): ImInboxPeer {
    const row = databaseRow(
      this.#db
        .prepare(
          "SELECT peer_server_id, peer_agent_id FROM contacts WHERE local_server_id = ? AND local_member_id = ? AND contact_id = ?",
        )
        .get(this.#localServerId, memberId, contactId),
    );
    if (!row) throw new ImContactNotFound();
    return { peerServerId: String(row.peer_server_id), peerAgentId: String(row.peer_agent_id) };
  }
}

function toContact(record: {
  contactId: string;
  peerServerId: string;
  peerAgentId: string;
  alias: string | null;
  state: "pending" | "accepted" | "removed";
  addedAt: number;
}): ImContact {
  return {
    contactId: record.contactId,
    peerServerId: record.peerServerId,
    peerAgentId: record.peerAgentId,
    alias: record.alias,
    state: record.state,
    addedAt: record.addedAt,
  };
}

function toReport(record: {
  reportId: string;
  targetPeer: string;
  category: ImReportCategory;
  detail: string | null;
  status: "open" | "reviewed" | "actioned" | "dismissed";
  createdAt: number;
  resolvedAt: number | null;
}): ImReport {
  return {
    reportId: record.reportId,
    targetPeer: record.targetPeer,
    category: record.category === "scam" ? "other" : record.category,
    detail: record.detail,
    status: record.status,
    createdAt: record.createdAt,
    resolvedAt: record.resolvedAt,
  };
}
